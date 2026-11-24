/**
 * The Codex driver: a second client of the app-server the agent already runs.
 *
 * An idle thread gets `turn/start`, a busy one `thread/queue/add`, so a message
 * waits for the running turn and never joins it. The driver never resumes a
 * thread, sends no per-turn overrides and never answers a request the server
 * makes of its clients (approvals included). The calls and their limits are in
 * `docs/drivers/codex.md`.
 *
 * `list` and `status` throw when the app-server cannot be reached: an empty
 * list would tell the broker that every session is gone.
 */
import { randomUUID } from "node:crypto";
import type { Capabilities, Delivered, Driver, Seen } from "./driver.js";
import { createConnection, type Connect, type Failure } from "./codex/connection.js";
import {
  isUnknownThreadMessage,
  queueAddSchema,
  textInput,
  threadListSchema,
  threadLoadedListSchema,
  threadReadSchema,
  turnStartSchema,
  type Thread,
} from "./codex/wire.js";

export { connectUnix } from "./codex/socket.js";
export { ALLOWED_METHODS } from "./codex/wire.js";

const LIST_LIMIT = 50;
const COLD_AFTER_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

const CAPABILITIES: Capabilities = { push: true, wakesIdle: true, joinsTurn: false, certainty: "confirmed" };

export type CodexOptions = {
  readonly connect: Connect;
  readonly now?: () => number;
  /** Ids for `thread/queue/add`, which the server wants from the client. */
  readonly newId?: () => string;
  readonly timeoutMs?: number;
  readonly clientVersion?: string;
};

type Activity = Seen["activity"];

const activityOf = (thread: Thread, loaded: boolean, now: number): Activity => {
  const kind = thread.status.type;
  if (!loaded || kind === "notLoaded") return "cold";
  if (kind === "active") return "busy";
  if (kind === "idle") return now - thread.updatedAt * 1000 > COLD_AFTER_MS ? "cold" : "idle";
  return "unknown";
};

const seen = (thread: Thread, loaded: boolean, now: number): Seen => ({
  session: thread.id,
  title: thread.name ?? null,
  activity: activityOf(thread, loaded, now),
});

const failureText = (failure: Failure): string => (failure.kind === "rpc" ? `the app-server answered: ${failure.message}` : failure.detail);

const isUnknownThread = (failure: Failure): boolean => failure.kind === "rpc" && isUnknownThreadMessage(failure.message);

const UNKNOWN_OUTCOME = "the outcome is unknown, and a retry could deliver the message twice";

export const createCodexDriver = (options: CodexOptions): Driver => {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const connection = createConnection({
    connect: options.connect,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    clientInfo: { name: "elserelay", title: "Elserelay", version: options.clientVersion ?? "0.0.0" },
  });

  const readThread = (session: string) => connection.call("thread/read", { threadId: session, includeTurns: false });

  const list: Driver["list"] = async () => {
    const listed = await connection.call("thread/list", { limit: LIST_LIMIT, sortKey: "updated_at", sortDirection: "desc" });
    if (!listed.ok) throw new Error(`thread/list failed: ${failureText(listed.failure)}`);
    const loaded = await connection.call("thread/loaded/list", {});
    if (!loaded.ok) throw new Error(`thread/loaded/list failed: ${failureText(loaded.failure)}`);
    const threads = threadListSchema.safeParse(listed.result);
    const ids = threadLoadedListSchema.safeParse(loaded.result);
    if (!threads.success || !ids.success) throw new Error("the app-server answered thread/list or thread/loaded/list in a shape the driver does not know");
    const inMemory = new Set(ids.data.data);
    const at = now();
    return threads.data.data.slice(0, LIST_LIMIT).map((thread) => seen(thread, inMemory.has(thread.id), at));
  };

  const status: Driver["status"] = async (session) => {
    const read = await readThread(session);
    if (!read.ok) {
      if (isUnknownThread(read.failure)) return null;
      throw new Error(`thread/read failed: ${failureText(read.failure)}`);
    }
    const parsed = threadReadSchema.safeParse(read.result);
    if (!parsed.success) throw new Error("the app-server answered thread/read in a shape the driver does not know");
    return seen(parsed.data.thread, true, now());
  };

  const refused = (detail: string, retry: boolean): Delivered => ({ ok: false, retry, detail });

  /** A failure of a call that changes nothing: trying again is harmless unless the server said the thread is not there. */
  const readFailed = (failure: Failure): Delivered =>
    isUnknownThread(failure) ? refused(`thread not found: ${failureText(failure)}`, false) : refused(`could not read the thread: ${failureText(failure)}`, true);

  /** A failure of the call that delivers. Once it was sent, silence means nobody knows. */
  const sendFailed = (method: string, failure: Failure): Delivered => {
    if (isUnknownThread(failure)) return refused(`thread not found: ${failureText(failure)}`, false);
    if (failure.kind === "closed" || failure.kind === "timeout") return refused(`${method} was sent and ${failure.detail}: ${UNKNOWN_OUTCOME}`, false);
    return refused(`${method} failed: ${failureText(failure)}`, true);
  };

  const unexpected = (method: string): Delivered => refused(`${method} was sent and the answer was not in a shape the driver knows: ${UNKNOWN_OUTCOME}`, false);

  const deliver: Driver["deliver"] = async (session, text) => {
    const read = await readThread(session);
    if (!read.ok) return readFailed(read.failure);
    const parsed = threadReadSchema.safeParse(read.result);
    if (!parsed.success) return refused("the app-server answered thread/read in a shape the driver does not know", false);
    const kind = parsed.data.thread.status.type;

    if (kind === "idle") {
      const started = await connection.call("turn/start", { threadId: session, input: textInput(text) });
      if (!started.ok) return sendFailed("turn/start", started.failure);
      return turnStartSchema.safeParse(started.result).success ? { ok: true, certainty: "confirmed" } : unexpected("turn/start");
    }
    if (kind === "active") {
      const queued = await connection.call("thread/queue/add", { threadId: session, clientUserMessageId: newId(), input: textInput(text) });
      if (!queued.ok) return sendFailed("thread/queue/add", queued.failure);
      return queueAddSchema.safeParse(queued.result).success ? { ok: true, certainty: "confirmed" } : unexpected("thread/queue/add");
    }
    if (kind === "notLoaded" || kind === "systemError") {
      return refused(`the thread is ${kind} in the app-server, and the driver never resumes a thread: open it in the agent first`, false);
    }
    return refused(`the thread has a status the driver does not know (${kind})`, false);
  };

  return { product: "codex", capabilities: () => CAPABILITIES, list, status, deliver };
};
