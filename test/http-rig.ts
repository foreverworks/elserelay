import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPClientTransport, testClient, toolJson } from "@foreverworks/mcp-kit";
import type { Client } from "@foreverworks/mcp-kit";
import { z } from "zod";
import { parseConfig } from "../src/broker/config.js";
import { realEffects, startBroker } from "../src/broker/main.js";
import type { Effects, Running } from "../src/broker/main.js";
import type { ToAdapter } from "../src/wire.js";
import { PUSH } from "./broker-fixtures.js";

export const TOKENS: Readonly<Record<string, string>> = {
  alpha: "alpha-token-0123456789",
  beta: "beta-token-0123456789a",
  ghost: "ghost-token-0123456789",
};

export type Harness = {
  readonly running: Running;
  readonly dir: string;
  readonly configPath: string;
  readonly lines: string[];
  readonly close: () => Promise<void>;
};

/** A real broker on free ports, with fast polling, in a temporary directory. */
export async function startHarness(options: { readonly policy: unknown; readonly deliveryTimeoutMs?: number; readonly effects?: Partial<Effects> }): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "agw-"));
  const tokensDir = join(dir, "tokens");
  mkdirSync(tokensDir);
  for (const [label, token] of Object.entries(TOKENS)) writeFileSync(join(tokensDir, `token-${label}`), token);
  const raw = {
    store: join(dir, "broker.sqlite"),
    tokensDir,
    listen: { mcpPort: 0, adapterPort: 0 },
    containers: { alpha: { product: "claude" }, beta: { product: "codex" } },
    deliveryTimeoutMs: options.deliveryTimeoutMs ?? 60_000,
    pollMs: 25,
    policy: options.policy,
  };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(raw));
  const parsed = parseConfig(raw);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  const lines: string[] = [];
  const running = await startBroker(parsed.config, { ...realEffects, log: (line) => lines.push(line), ...options.effects });
  return {
    running,
    dir,
    configPath,
    lines,
    close: async () => {
      await running.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const adapterUrl = (h: Harness, path: string): string => `http://127.0.0.1:${h.running.adapterPort}${path}`;
export const mcpUrl = (h: Harness): string => `http://127.0.0.1:${h.running.mcpPort}/mcp`;

const bearer = (token: string | null): Record<string, string> => (token === null ? {} : { authorization: `Bearer ${token}` });

export async function mcpClient(h: Harness, label: string, token: string | null = TOKENS[label] ?? null): Promise<Client> {
  const client = testClient(label);
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(h)), { requestInit: { headers: bearer(token) } }));
  return client;
}

export type ToolAnswer = { readonly isError: boolean; readonly json: Record<string, unknown> };

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, json: toolJson(result) };
}

const toAdapter = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ping") }),
  z.object({
    kind: z.literal("deliver"),
    id: z.string(),
    attempt: z.number(),
    to: z.object({ container: z.string(), product: z.string(), session: z.string() }),
    text: z.string(),
  }),
]);

export type Delivery = Extract<ToAdapter, { kind: "deliver" }>;

/** An adapter as a test writes it: the wire of src/wire.ts, nothing of the real adapter. */
export type FakeAdapter = {
  readonly deliveries: Delivery[];
  readonly pings: () => number;
  readonly closed: () => boolean;
  readonly post: (path: string, body: unknown) => Promise<number>;
  readonly report: (product: string, sessions: readonly { session: string; title: string | null; activity: string }[]) => Promise<number>;
  readonly outcome: (id: string, attempt: number, ok?: boolean) => Promise<number>;
  readonly close: () => void;
};

export async function fakeAdapter(h: Harness, label: string, token: string | null = TOKENS[label] ?? null): Promise<FakeAdapter> {
  const deliveries: Delivery[] = [];
  let pings = 0;
  let closed = false;
  const controller = new AbortController();
  const response = await fetch(adapterUrl(h, "/adapter/stream"), { headers: bearer(token), signal: controller.signal });
  if (response.status !== 200 || response.body === null) throw new Error(`stream refused with ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf("\n\n");
          if (!frame.startsWith("data: ")) continue;
          const event = toAdapter.parse(JSON.parse(frame.slice("data: ".length)));
          if (event.kind === "ping") pings += 1;
          else deliveries.push(event as Delivery);
        }
      }
    } catch {
      // aborted by close()
    }
    closed = true;
  })();

  const post = async (path: string, body: unknown): Promise<number> => {
    const res = await fetch(adapterUrl(h, path), { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });
    await res.arrayBuffer();
    return res.status;
  };
  return {
    deliveries,
    pings: () => pings,
    closed: () => closed,
    post,
    report: (product, sessions) => post("/adapter/report", { product, capabilities: PUSH, sessions }),
    outcome: (id, attempt, ok = true) =>
      post("/adapter/outcome", { id, attempt, result: ok ? { ok: true, certainty: "confirmed" } : { ok: false, retry: false, detail: "no" } }),
    close: () => controller.abort(),
  };
}

export async function waitFor(what: string, check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
