import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@foreverworks/mcp-kit";
import type { McpServer } from "@foreverworks/mcp-kit";
import { z } from "zod";

export const TOKEN = "elsewire-token-0123456789";

/** What an `elsewire_await` call gets: an object is its JSON result, "error" a tool-level error, "pending" the usual wait. */
export type AwaitReply = Record<string, unknown> | "error";

export type FakeElsewire = {
  url: string;
  readonly tokenFile: string;
  readonly requests: Record<string, unknown>[];
  readonly awaits: Record<string, unknown>[];
  /** The arguments of every `elsewire_cancel` call. */
  readonly cancels: Record<string, unknown>[];
  /** The replies the next awaits get, in order; once they are used up an await says pending. */
  readonly script: AwaitReply[];
  /** Called inside each await, to look at the world while the approver is waiting. */
  onAwait: (args: Record<string, unknown>) => void;
  /** While set, an await does not answer until it settles: a wait that is really in flight. */
  gate: Promise<void> | null;
  close: () => Promise<void>;
};

const text = (json: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(json) }] });

/** An Elsewire as the approver sees it: two tools of a real MCP server over streamable HTTP, behind a bearer token. */
export async function fakeElsewire(): Promise<FakeElsewire> {
  const dir = mkdtempSync(join(tmpdir(), "agw-elsewire-"));
  const tokens = join(dir, "tokens");
  mkdirSync(tokens);
  writeFileSync(join(tokens, "token-approver"), TOKEN);
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, `${TOKEN}\n`);

  const fake: FakeElsewire = {
    url: "",
    tokenFile,
    requests: [],
    awaits: [],
    cancels: [],
    gate: null,
    script: [],
    onAwait: () => undefined,
    close: async () => undefined,
  };

  const register = (server: McpServer): void => {
    server.registerTool(
      "elsewire_request",
      {
        description: "Ask a person.",
        inputSchema: {
          connector: z.string(),
          title: z.string(),
          draft: z.string().optional(),
          timeout_sec: z.number().optional(),
          replies: z.array(z.string()).optional(),
          requester: z.record(z.string(), z.unknown()),
          notes: z.boolean().optional(),
        },
      },
      async (args: Record<string, unknown>) => {
        fake.requests.push(args);
        return text({ id: `req-${fake.requests.length}`, status: "pending" });
      },
    );
    server.registerTool(
      "elsewire_await",
      { description: "Wait for the answer.", inputSchema: { id: z.string(), timeout_sec: z.number().optional() } },
      async (args: Record<string, unknown>) => {
        fake.awaits.push(args);
        fake.onAwait(args);
        if (fake.gate !== null) await fake.gate;
        const next = fake.script.shift() ?? { status: "pending" };
        if (next === "error") return { content: [{ type: "text" as const, text: "boom" }], isError: true as const };
        return text(next);
      },
    );
    server.registerTool(
      "elsewire_cancel",
      { description: "Stop a request.", inputSchema: { id: z.string() } },
      async (args: Record<string, unknown>) => {
        fake.cancels.push(args);
        return text({ id: args["id"], status: "cancelled" });
      },
    );
  };

  const served = await serve({
    name: "fake-elsewire",
    version: "0.0.0",
    register,
    policy: { elsewire_request: { access: "write" }, elsewire_await: { access: "read" }, elsewire_cancel: { access: "write" } },
    env: { MCP_HTTP_PORT: "0", MCP_HTTP_TOKENS_DIR: tokens },
    log: () => undefined,
  });
  fake.url = `http://127.0.0.1:${served.port}/mcp`;
  fake.close = async () => {
    await served.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return fake;
}
