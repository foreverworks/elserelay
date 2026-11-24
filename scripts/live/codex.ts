/**
 * The Codex side of a live run: an app-server this script starts on a Unix socket it owns, and clients
 * of it that log every frame. A client answers a request of the server only when its owner says so.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { oneLine, record, until } from "./util.ts";

export type Frame = { readonly at: number; readonly dir: "in" | "out"; readonly body: Record<string, unknown> };

export type RpcAnswer = { readonly ok: boolean; readonly result: Record<string, unknown>; readonly error: string };

export type ServerRequest = { readonly at: number; readonly id: string | number; readonly method: string; readonly params: Record<string, unknown> };

export type CodexClient = {
  readonly name: string;
  /** Every frame in either direction, in order. */
  readonly frames: Frame[];
  /** Requests the server made of this client, in order. */
  readonly requests: ServerRequest[];
  readonly rpc: (method: string, params: unknown, timeoutMs?: number) => Promise<RpcAnswer>;
  /** Answers a request of the server. Only a client the script means to answer ever calls this. */
  readonly respond: (id: string | number, result: unknown) => void;
  readonly close: () => void;
  readonly closed: () => boolean;
};

export type ClientOptions = {
  readonly name: string;
  readonly socket: string;
  /** A JSON-lines file with every frame. */
  readonly log: string;
  /** What the log may not say, such as a thread id. */
  readonly mask: (text: string) => string;
  readonly experimental?: boolean;
  /** Called for each request the server makes of this client, after it is recorded. */
  readonly onRequest?: (request: ServerRequest, client: CodexClient) => void;
};

export async function openClient(o: ClientOptions): Promise<CodexClient> {
  const ws = new WebSocket(`ws+unix://${o.socket}:/`, { handshakeTimeout: 5000 });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const out = createWriteStream(o.log, { flags: "a" });
  const frames: Frame[] = [];
  const requests: ServerRequest[] = [];
  const pending = new Map<number, (answer: RpcAnswer) => void>();
  let nextId = 1;
  let closed = false;
  const note = (dir: Frame["dir"], body: Record<string, unknown>): void => {
    const frame = { at: Date.now(), dir, body };
    frames.push(frame);
    out.write(`${o.mask(JSON.stringify({ client: o.name, ...frame }))}\n`);
  };
  const send = (body: Record<string, unknown>): void => {
    note("out", body);
    ws.send(JSON.stringify(body));
  };
  const client: CodexClient = {
    name: o.name,
    frames,
    requests,
    rpc: (method, params, timeoutMs = 20_000) =>
      new Promise((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) resolve({ ok: false, result: {}, error: `no answer to ${method} within ${timeoutMs} ms` });
        }, timeoutMs);
        pending.set(id, (answer) => {
          clearTimeout(timer);
          resolve(answer);
        });
        send({ id, method, params });
      }),
    respond: (id, result) => send({ id, result }),
    close: () => ws.close(),
    closed: () => closed,
  };
  ws.on("close", () => {
    closed = true;
    out.end();
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const body = record(JSON.parse(data.toString()));
    if (body === null) return;
    note("in", body);
    const id = body["id"];
    const method = body["method"];
    if (typeof method === "string" && (typeof id === "number" || typeof id === "string")) {
      const request = { at: Date.now(), id, method, params: record(body["params"]) ?? {} };
      requests.push(request);
      o.onRequest?.(request, client);
      return;
    }
    if (typeof id === "number" && typeof method !== "string") {
      const resolve = pending.get(id);
      if (resolve === undefined) return;
      pending.delete(id);
      const error = record(body["error"]);
      resolve({ ok: error === null, result: record(body["result"]) ?? {}, error: error === null ? "" : String(error["message"]) });
    }
  });
  const hello = await client.rpc("initialize", {
    clientInfo: { name: o.name, title: null, version: "0.0.0" },
    capabilities: o.experimental === false ? null : { experimentalApi: true, requestAttestation: false },
  });
  if (!hello.ok) throw new Error(`initialize failed: ${hello.error}`);
  send({ method: "initialized" });
  return client;
}

export type AppServerOptions = {
  readonly bin: string;
  readonly codexHome: string;
  /** A folder of mode 0700 that holds the socket. */
  readonly socketDir: string;
  readonly cwd: string;
  /** Becomes `-c key=value` arguments. */
  readonly config: readonly (readonly [string, string])[];
  /** The environment the app-server gets, besides PATH and its home. The bearer goes here and never in the arguments. */
  readonly env: Record<string, string>;
  readonly log: string;
  readonly children: ChildProcess[];
};

export type AppServer = { readonly child: ChildProcess; readonly socket: string };

export async function startAppServer(o: AppServerOptions): Promise<AppServer> {
  mkdirSync(o.socketDir, { recursive: true, mode: 0o700 });
  const socket = join(o.socketDir, "app-server.sock");
  const args = [...o.config.flatMap(([key, value]) => ["-c", `${key}=${value}`]), "app-server", "--listen", `unix://${socket}`];
  const child = spawn(o.bin, args, {
    cwd: o.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env["PATH"] ?? "", HOME: dirname(o.socketDir), CODEX_HOME: o.codexHome, ...o.env },
  });
  const log = createWriteStream(o.log);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log);
  o.children.push(child);
  await until("the app-server to listen", 30_000, async () => {
    try {
      const probe = await openClient({ name: "probe-start", socket, log: `${o.log}.probe`, mask: (t) => t, experimental: false });
      probe.close();
      return true;
    } catch {
      return false;
    }
  });
  return { child, socket };
}

// ---------------------------------------------------------------- reading what a client saw

const textOfItem = (item: Record<string, unknown>): string => {
  const text = item["text"];
  return typeof text === "string" ? text : "";
};

/** The notifications of one method for one thread, in order. */
export const notifications = (client: CodexClient, method: string, threadId?: string): Record<string, unknown>[] =>
  client.frames
    .filter((f) => f.dir === "in" && f.body["method"] === method && (threadId === undefined || record(f.body["params"])?.["threadId"] === threadId))
    .map((f) => record(f.body["params"]) ?? {});

export const turnsCompleted = (client: CodexClient, threadId: string): number => notifications(client, "turn/completed", threadId).length;

/** Items a client saw finish in a thread: `agentMessage` (its words), `mcpToolCall`, `commandExecution`. */
export function itemsOf(client: CodexClient, threadId: string, type?: string): Record<string, unknown>[] {
  return notifications(client, "item/completed", threadId)
    .map((p) => record(p["item"]) ?? {})
    .filter((item) => type === undefined || item["type"] === type);
}

export const sayings = (client: CodexClient, threadId: string, from = 0): string[] =>
  itemsOf(client, threadId, "agentMessage")
    .slice(from)
    .map(textOfItem)
    .filter((t) => t !== "");

export const describeItem = (item: Record<string, unknown>): string => {
  const kind = String(item["type"]);
  if (kind === "mcpToolCall") return `mcp ${String(item["server"])}.${String(item["tool"])} (${String(item["status"])})`;
  if (kind === "commandExecution") return `command ${oneLine(String(item["command"]), 80)} (${String(item["status"])})`;
  return kind;
};

/** The thread status types the client was told about, in order, as `idle`, `active`, `active:waitingOnApproval`. */
export function statusTrail(client: CodexClient, threadId: string): { at: number; status: string }[] {
  return client.frames
    .filter((f) => f.dir === "in" && f.body["method"] === "thread/status/changed" && record(f.body["params"])?.["threadId"] === threadId)
    .map((f) => {
      const status = record(record(f.body["params"])?.["status"]);
      const flags = Array.isArray(status?.["activeFlags"]) ? (status["activeFlags"] as unknown[]).map(String).join("+") : "";
      return { at: f.at, status: `${String(status?.["type"])}${flags === "" ? "" : `:${flags}`}` };
    });
}
