/**
 * `agent-gateway approver elsewire`: a command for the broker's `command`
 * approver. It reads one approval request on stdin, asks a person through an
 * Elsewire server (an MCP server over streamable HTTP with a bearer token), and
 * prints `{"answer":"approve"}` or `{"answer":"refuse"}` (with the reason
 * `too-long` when the text is more than a person can be asked to read).
 *
 * What the person is shown is the text the receiving session will be handed, as
 * the gateway's `render` builds it from the request, with every control character
 * escaped, so the sender's claimed session title and every other line of it are
 * in front of the person too. A yes counts only when what comes back is that
 * text, unedited: the gateway never rewrites a sender's words, so an edited text
 * is a refusal. The request allows no note, and an answer that carries one is a
 * refusal, so nothing can be said that is not in the text.
 *
 * The broker ends the command with SIGTERM when the question is over (the message
 * was answered elsewhere, reached its deadline or is not held any more): the
 * request is then cancelled on the server and forgotten. It ends it with SIGINT
 * when only the broker is going away: the request stays open and its state file
 * stays, so the next broker run picks it up.
 * Settings come from the environment: ELSEWIRE_URL, ELSEWIRE_TOKEN_FILE and
 * ELSEWIRE_STATE_DIR (or the AGENT_GATEWAY_APPROVER_STATE_DIR the broker sets).
 * Neither the token nor a message body is ever written to stderr.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@foreverworks/mcp-kit";
import { z } from "zod";
import { escapeForTerminal } from "../broker/approver.js";
import type { StopWhy } from "../broker/command.js";
import { render } from "../core/render.js";
import { PRODUCTS } from "../core/types.js";

/** A person must be able to read all of what they approve. */
export const MAX_DRAFT_CHARS = 4000;
export const AWAIT_SECONDS = 50;
export const MIN_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 86_400;
/** Elsewire's limit on a title, counted in UTF-16 units like the server counts. */
export const TITLE_CHARS = 200;
/** A state file this old belongs to a request that has long ended (a message is held for 7 days at most). */
export const STATE_MAX_AGE_MS = 7 * 86_400_000;
/** A temporary file this old was left by a run that died between writing and renaming. */
export const TMP_MAX_AGE_MS = 3_600_000;

const request = z.object({
  id: z.string().min(1),
  thread: z.string().min(1),
  hop: z.number().int().min(0),
  from: z.object({ container: z.string(), product: z.enum(PRODUCTS), session: z.string(), title: z.string().nullable() }),
  to: z.object({ container: z.string(), product: z.string(), session: z.string() }),
  body: z.string(),
  decideBy: z.number(),
});
export type Request = z.infer<typeof request>;

const created = z.object({ id: z.string().min(1) });
const awaited = z.object({
  status: z.enum(["pending", "done", "denied", "failed", "expired", "cancelled"]),
  answer: z.object({ text: z.string(), edited: z.boolean(), note: z.string().nullish() }).optional(),
});

const settings = z.object({
  ELSEWIRE_URL: z.url(),
  ELSEWIRE_TOKEN_FILE: z.string().min(1),
  state: z.string().min(1),
});

/** The tools of the Elsewire server, as parsed JSON: a failure to reach it or a tool that reports an error throws. */
export type Tools = {
  readonly call: (name: string, args: Readonly<Record<string, unknown>>, timeoutMs: number) => Promise<unknown>;
  readonly close: () => Promise<void>;
};

/** One small file per request, named by the hash of the broker's message id. */
export type StateIo = {
  readonly read: (name: string) => Promise<string | undefined>;
  readonly write: (name: string, content: string) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
  /** Makes sure files can be written: creates the folder, keeps it private to its owner, and fails when it cannot be written to. */
  readonly prepare: () => Promise<void>;
  /** Removes state files older than a week and stale temporary files; returns how many. Never throws. */
  readonly sweep: (nowMs: number) => Promise<number>;
};

export type Effects = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: () => Promise<string>;
  readonly readToken: (path: string) => Promise<string>;
  readonly state: (dir: string) => StateIo;
  readonly connect: (url: string, token: string) => Tools;
  /** The name of the machine the request comes from. */
  readonly host: string;
  /** Settles with why the command is being stopped: the broker's SIGTERM is `moot`, its SIGINT `shutdown`. Never settles when nothing stops it. */
  readonly stopped: Promise<StopWhy>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

const oneLine = (text: string): string => escapeForTerminal(text).replace(/\n/g, " ");

/** The title the person reads: who asks to send to whom, cleaned to one line of at most 200 UTF-16 units, never cut inside a surrogate pair. */
export function titleOf(r: { readonly from: { readonly container: string; readonly product: string }; readonly to: { readonly container: string; readonly product: string } }): string {
  const title = oneLine(`Let this message go? ${r.from.container} (${r.from.product}) to ${r.to.container} (${r.to.product})`);
  if (title.length <= TITLE_CHARS) return title;
  let end = TITLE_CHARS - 1;
  const last = title.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${title.slice(0, end)}…`;
}

/**
 * A text as the person reads it. A draft is shown formatted, and formatting can hide text (a link's target, a comment,
 * white-on-white markup), so the text goes inside a code fence longer than any run of backticks in it.
 */
export function draftOf(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${escapeForTerminal(text)}\n${fence}`;
}

/** Exactly what a yes delivers, as the person is shown it: the receiving session's text, built the way the broker builds it. */
export const draftForMessage = (r: Request): string => draftOf(render(r));

/** Who is asking, which Elsewire requires: the gateway itself, for one thread. A gateway has no page to link to. */
export const requesterOf = (r: Request, host: string): Record<string, unknown> => ({
  client: "agent-gateway",
  session: r.thread,
  title: titleOf(r),
  host,
  extra: { session_url_unavailable: "a gateway message has no web page", message: r.id, from_session: oneLine(r.from.session), to_session: oneLine(r.to.session) },
});

export const timeoutSeconds = (decideBy: number, now: number): number =>
  Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.ceil((decideBy - now) / 1000)));

const stateName = (id: string): string => createHash("sha256").update(id, "utf8").digest("hex");

const isLoopback = (host: string): boolean => host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);

/**
 * A bearer token goes over TLS, or to this machine. `allowHttp` is for a network that encrypts on its own (a WireGuard
 * mesh, say); it is a setting because only the operator knows that.
 */
export function urlProblem(url: string, allowHttp = false): string | null {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && (allowHttp || isLoopback(parsed.hostname))) return null;
  return "ELSEWIRE_URL must be https (http is accepted only for a loopback address, or with ELSEWIRE_ALLOW_HTTP=1 on a network that encrypts on its own)";
}

type Verdict = { readonly kind: "approve" } | { readonly kind: "refuse"; readonly reason?: "too-long" } | { readonly kind: "none" };
const NONE: Verdict = { kind: "none" };
const REFUSE: Verdict = { kind: "refuse" };

const STOPPED = Symbol("stopped");
type Stop = { readonly [STOPPED]: StopWhy };
const isStop = (value: unknown): value is Stop => typeof value === "object" && value !== null && STOPPED in value;

async function decide(r: Request, tools: Tools, state: StateIo, effects: Effects): Promise<Verdict> {
  const { err, now, sleep } = effects;
  // A call or a pause that the broker's stop signal cuts short. A request that is being created is not cut: it is finished first,
  // so that its id is known and can be cancelled or kept.
  const stopAware = <T>(work: Promise<T>): Promise<T | Stop> => Promise.race([work, effects.stopped.then((why): Stop => ({ [STOPPED]: why }))]);
  const cancel = async (id: string): Promise<void> => {
    try {
      await tools.call("elsewire_cancel", { id }, 10_000);
    } catch (error) {
      // The name only: a message of a failed call could quote what was sent.
      err(`message ${r.id}: the request could not be cancelled (${error instanceof Error ? error.name : "failed"}); it ends by itself at the deadline`);
    }
  };

  const draft = draftForMessage(r);
  if (draft.length > MAX_DRAFT_CHARS) {
    err(`message ${r.id} is longer than ${MAX_DRAFT_CHARS} characters as a person would read it, more than a person can be asked to read in one go: refused without asking`);
    return { kind: "refuse", reason: "too-long" };
  }
  const name = stateName(r.id);
  let elsewireId = (await state.read(name))?.trim();
  if (elsewireId === undefined || elsewireId === "") {
    if (r.decideBy <= now()) return REFUSE;
    try {
      await state.prepare();
    } catch {
      err("the state directory cannot be written to, so nothing was asked (a question that is not on disk would be asked again after every restart)");
      return NONE;
    }
    const made = created.parse(
      await tools.call(
        "elsewire_request",
        // No note: a person could write "don't send" and still send the text. An answer with a note is a refusal below.
        { connector: "review", title: titleOf(r), draft, timeout_sec: timeoutSeconds(r.decideBy, now()), replies: ["Refuse"], notes: false, requester: requesterOf(r, effects.host) },
        30_000,
      ),
    );
    elsewireId = made.id;
    // Written before the first wait, so a restart picks the same question up again instead of asking twice.
    try {
      await state.write(name, elsewireId);
    } catch {
      err(`message ${r.id}: the state file cannot be written; the request is cancelled so that it is not left open without a record`);
      await cancel(elsewireId);
      return NONE;
    }
    err(`asked about message ${r.id}`);
  } else {
    err(`waiting again for the answer about message ${r.id}`);
  }

  for (;;) {
    if (now() >= r.decideBy) {
      await state.remove(name);
      return REFUSE;
    }
    const startedAt = now();
    const raw = await stopAware(tools.call("elsewire_await", { id: elsewireId, timeout_sec: AWAIT_SECONDS }, (AWAIT_SECONDS + 15) * 1000));
    if (isStop(raw)) return onStop(raw[STOPPED], r.id, elsewireId, name, state, cancel, err);
    const status = awaited.parse(raw);
    switch (status.status) {
      case "pending": {
        // A server that answers "pending" at once would make this a busy loop.
        const took = now() - startedAt;
        if (took < 1000) {
          const paused = await stopAware(sleep(1000 - took));
          if (isStop(paused)) return onStop(paused[STOPPED], r.id, elsewireId, name, state, cancel, err);
        }
        continue;
      }
      case "done": {
        await state.remove(name);
        const note = status.answer?.note?.trim() ?? "";
        if (note !== "") {
          err(`message ${r.id}: the answer carried a note, which the request did not allow; it is a refusal`);
          return REFUSE;
        }
        if (status.answer?.edited === false && status.answer.text === draft) return { kind: "approve" };
        if (status.answer?.edited === true) err(`message ${r.id}: the answer was an edited text; the gateway never rewrites a sender's words, so it is a refusal`);
        return REFUSE;
      }
      case "denied":
      case "expired":
      case "cancelled":
        await state.remove(name);
        return REFUSE;
      case "failed":
        // The request is dead on the server: the next try must ask afresh.
        await state.remove(name);
        err(`message ${r.id}: the Elsewire request failed`);
        return NONE;
    }
  }
}

/** SIGTERM: the question is moot, so it is withdrawn. SIGINT: only the broker is going, so the question is left as it is. */
async function onStop(
  why: StopWhy,
  messageId: string,
  elsewireId: string,
  name: string,
  state: StateIo,
  cancel: (id: string) => Promise<void>,
  err: (line: string) => void,
): Promise<Verdict> {
  if (why === "shutdown") {
    err(`message ${messageId}: the broker is stopping; the request stays open for the next run`);
    return NONE;
  }
  err(`message ${messageId}: the question is over; the request is cancelled`);
  await cancel(elsewireId);
  await state.remove(name).catch(() => undefined);
  return NONE;
}

/** Returns the exit code: 0 with an answer on stdout, 1 with none. */
export async function runElsewireApprover(effects: Effects): Promise<number> {
  const { env, out, err } = effects;
  const config = settings.safeParse({
    ELSEWIRE_URL: env["ELSEWIRE_URL"],
    ELSEWIRE_TOKEN_FILE: env["ELSEWIRE_TOKEN_FILE"],
    state: env["ELSEWIRE_STATE_DIR"] ?? env["AGENT_GATEWAY_APPROVER_STATE_DIR"],
  });
  if (!config.success) {
    err(`settings: ${config.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")} (ELSEWIRE_URL, ELSEWIRE_TOKEN_FILE and ELSEWIRE_STATE_DIR are needed)`);
    return 1;
  }
  const problem = urlProblem(config.data.ELSEWIRE_URL, env["ELSEWIRE_ALLOW_HTTP"] === "1");
  if (problem !== null) {
    err(problem);
    return 1;
  }
  let parsed: Request;
  try {
    parsed = request.parse(JSON.parse(await effects.stdin()));
  } catch {
    err("the request on stdin is not the JSON the broker sends");
    return 1;
  }

  let token: string;
  try {
    token = (await effects.readToken(config.data.ELSEWIRE_TOKEN_FILE)).trim();
  } catch {
    err("cannot read the token file");
    return 1;
  }
  if (token === "") {
    err("the token file is empty");
    return 1;
  }

  const state = effects.state(config.data.state);
  const swept = await state.sweep(effects.now());
  if (swept > 0) err(`removed ${swept} old file${swept === 1 ? "" : "s"} from the state directory`);

  const tools = effects.connect(config.data.ELSEWIRE_URL, token);
  try {
    const verdict = await decide(parsed, tools, state, effects);
    if (verdict.kind === "none") return 1;
    out(JSON.stringify(verdict.kind === "refuse" && verdict.reason !== undefined ? { answer: "refuse", reason: verdict.reason } : { answer: verdict.kind }));
    return 0;
  } catch (error) {
    // The name only: a message of a failed call could quote what was sent.
    err(`no answer: ${error instanceof Error ? error.name : "failed"}`);
    return 1;
  } finally {
    await tools.close().catch(() => undefined);
  }
}

/** The text of a tool result: structured content when there is one, else the JSON in its text. */
export function resultJson(result: {
  readonly isError?: boolean | undefined;
  readonly content?: readonly unknown[] | undefined;
  readonly structuredContent?: unknown;
}): unknown {
  if (result.isError === true) throw new Error("the tool reported an error");
  if (typeof result.structuredContent === "object" && result.structuredContent !== null) return result.structuredContent;
  for (const block of result.content ?? []) {
    if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
      return JSON.parse(block.text);
    }
  }
  throw new Error("the tool result holds no JSON");
}

/** The real MCP client, connected on first use. */
export function mcpTools(url: string, token: string): Tools {
  let client: Client | undefined;
  const connected = async (): Promise<Client> => {
    if (client !== undefined) return client;
    const made = new Client({ name: "agent-gateway-approver", version: "1.0.0" });
    await made.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    client = made;
    return made;
  };
  return {
    call: async (name, args, timeoutMs) => resultJson(await (await connected()).callTool({ name, arguments: { ...args } }, { timeout: timeoutMs })),
    close: async () => {
      await client?.close();
    },
  };
}

const STATE_FILE = /^[0-9a-f]{64}$/;
const TMP_FILE = /^[0-9a-f]{64}\.\d+\.tmp$/;

export function nodeState(dir: string): StateIo {
  const file = (name: string): string => join(dir, name);
  return {
    read: async (name) => {
      try {
        return await readFile(file(name), "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    write: async (name, content) => {
      const temp = file(`${name}.${process.pid}.tmp`);
      try {
        await writeFile(temp, content, { mode: 0o600 });
        await rename(temp, file(name));
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    remove: async (name) => {
      await rm(file(name), { force: true });
    },
    prepare: async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // A folder that already existed keeps whatever mode it had; tighten it when it is ours, and leave someone else's alone.
      if ((await stat(dir)).uid === process.getuid?.()) await chmod(dir, 0o700);
      await access(dir, constants.W_OK | constants.X_OK);
    },
    sweep: async (nowMs) => {
      let removed = 0;
      try {
        for (const name of await readdir(dir)) {
          const maxAge = STATE_FILE.test(name) ? STATE_MAX_AGE_MS : TMP_FILE.test(name) ? TMP_MAX_AGE_MS : undefined;
          if (maxAge === undefined) continue;
          try {
            const info = await stat(file(name));
            if (info.isFile() && nowMs - info.mtimeMs > maxAge) {
              await rm(file(name), { force: true });
              removed += 1;
            }
          } catch {
            // Gone already, or not ours to remove: the next run tries again.
          }
        }
      } catch {
        // No folder yet, or none that can be read: there is nothing to clean.
      }
      return removed;
    },
  };
}
