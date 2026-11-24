/**
 * `agent-gateway approver elsewire`: a command for the broker's `command`
 * approver. It reads one approval request on stdin, asks a person through an
 * Elsewire server (an MCP server over streamable HTTP with a bearer token), and
 * prints `{"answer":"approve"}` or `{"answer":"refuse"}`.
 *
 * What the person is shown is the message exactly as the broker would show it on
 * a terminal, and a yes counts only when what comes back is that text, unedited:
 * the gateway never rewrites a sender's words, so an edited text is a refusal.
 * Settings come from the environment: ELSEWIRE_URL, ELSEWIRE_TOKEN_FILE and
 * ELSEWIRE_STATE_DIR (or the AGENT_GATEWAY_APPROVER_STATE_DIR the broker sets).
 * Neither the token nor a message body is ever written to stderr.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@foreverworks/mcp-kit";
import { z } from "zod";
import { escapeForTerminal } from "../broker/approver.js";

/** A person must be able to read all of what they approve. */
export const MAX_DRAFT_CHARS = 4000;
export const AWAIT_SECONDS = 50;
export const MIN_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 86_400;
export const TITLE_CHARS = 200;

const request = z.object({
  id: z.string().min(1),
  thread: z.string().min(1),
  from: z.object({ container: z.string(), product: z.string(), session: z.string() }),
  to: z.object({ container: z.string(), product: z.string(), session: z.string() }),
  body: z.string(),
  decideBy: z.number(),
});
export type Request = z.infer<typeof request>;

const created = z.object({ id: z.string().min(1) });
const awaited = z.object({
  status: z.enum(["pending", "done", "denied", "failed", "expired", "cancelled"]),
  answer: z.object({ text: z.string(), edited: z.boolean() }).optional(),
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
};

export type Effects = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: () => Promise<string>;
  readonly readToken: (path: string) => Promise<string>;
  readonly state: (dir: string) => StateIo;
  readonly connect: (url: string, token: string) => Tools;
  /** The name of the machine the request comes from. */
  readonly host: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

const oneLine = (text: string): string => escapeForTerminal(text).replace(/\n/g, " ");

/** The title the person reads: who asks to send to whom, cleaned to one line of at most 200 characters. */
export function titleOf(r: { readonly from: Pick<Request["from"], "container" | "product">; readonly to: Pick<Request["to"], "container" | "product"> }): string {
  const title = oneLine(`Let this message go? ${r.from.container} (${r.from.product}) to ${r.to.container} (${r.to.product})`);
  const chars = Array.from(title);
  return chars.length <= TITLE_CHARS ? title : `${chars.slice(0, TITLE_CHARS - 1).join("")}…`;
}

/**
 * The body as the person reads it. A draft is shown formatted, and formatting can hide text (a link's target, a comment,
 * white-on-white markup), so the body goes inside a code fence longer than any run of backticks in it.
 */
export function draftOf(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${escapeForTerminal(body)}\n${fence}`;
}

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

type Verdict = "approve" | "refuse" | "none";

async function decide(r: Request, tools: Tools, state: StateIo, effects: Effects): Promise<Verdict> {
  const { err, now, sleep } = effects;
  const draft = draftOf(r.body);
  if (draft.length > MAX_DRAFT_CHARS) {
    err(`message ${r.id} is longer than ${MAX_DRAFT_CHARS} characters, more than a person can be asked to read in one go: refused without asking`);
    return "refuse";
  }
  const name = stateName(r.id);
  let elsewireId = (await state.read(name))?.trim();
  if (elsewireId === undefined || elsewireId === "") {
    if (r.decideBy <= now()) return "refuse";
    const made = created.parse(
      await tools.call(
        "elsewire_request",
        { connector: "review", title: titleOf(r), draft, timeout_sec: timeoutSeconds(r.decideBy, now()), replies: ["Refuse"], requester: requesterOf(r, effects.host) },
        30_000,
      ),
    );
    elsewireId = made.id;
    // Written before the first wait, so a restart picks the same question up again instead of asking twice.
    await state.write(name, elsewireId);
    err(`asked about message ${r.id}`);
  } else {
    err(`waiting again for the answer about message ${r.id}`);
  }

  for (;;) {
    if (now() >= r.decideBy) {
      await state.remove(name);
      return "refuse";
    }
    const startedAt = now();
    const status = awaited.parse(await tools.call("elsewire_await", { id: elsewireId, timeout_sec: AWAIT_SECONDS }, (AWAIT_SECONDS + 15) * 1000));
    switch (status.status) {
      case "pending": {
        // A server that answers "pending" at once would make this a busy loop.
        const took = now() - startedAt;
        if (took < 1000) await sleep(1000 - took);
        continue;
      }
      case "done": {
        await state.remove(name);
        if (status.answer?.edited === false && status.answer.text === draft) return "approve";
        if (status.answer?.edited === true) err(`message ${r.id}: the answer was an edited text; the gateway never rewrites a sender's words, so it is a refusal`);
        return "refuse";
      }
      case "denied":
      case "expired":
      case "cancelled":
        await state.remove(name);
        return "refuse";
      case "failed":
        // The request is dead on the server: the next try must ask afresh.
        await state.remove(name);
        err(`message ${r.id}: the Elsewire request failed`);
        return "none";
    }
  }
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

  const tools = effects.connect(config.data.ELSEWIRE_URL, token);
  try {
    const verdict = await decide(parsed, tools, effects.state(config.data.state), effects);
    if (verdict === "none") return 1;
    out(JSON.stringify({ answer: verdict }));
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
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = file(`${name}.${process.pid}.tmp`);
      await writeFile(temp, content, { mode: 0o600 });
      await rename(temp, file(name));
    },
    remove: async (name) => {
      await rm(file(name), { force: true });
    },
  };
}
