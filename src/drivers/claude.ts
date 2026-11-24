/**
 * Claude Code. Sessions are found in `~/.claude/sessions/<pid>.json` and a
 * message goes in as one JSON line on the session's Unix socket. How and why is
 * in docs/drivers/claude.md. The `*.key` files beside the records are never read.
 */
import { connect } from "node:net";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Capabilities, Delivered, Driver, Seen } from "./driver.js";

/** The line the session's socket takes. The sender's name is in the text, because the model is not shown `from`. */
const FROM = "agent-gateway";
const SUPPORTED_PEER_PROTOCOL = 1;
const COLD_AFTER_MS = 60 * 60 * 1000;
/** How long a socket that stays quiet is taken to have kept the message. */
export const ACCEPT_WAIT_MS = 300;
const CONNECT_LIMIT_MS = 5000;

/** Read as untrusted: the file is written by another program and any session user could plant one. */
const record = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  name: z.string().nullish(),
  status: z.string().nullish(),
  statusUpdatedAt: z.number().nullish(),
  messagingSocketPath: z.string().min(1),
  peerProtocol: z.number().nullish(),
});
type SessionRecord = z.infer<typeof record>;

/** `retry` is false once the line may have reached the session: a second copy could be read as a second message. */
export type SendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retry: boolean; readonly detail: string };

export type ClaudeEnv = {
  readonly dir: string;
  readonly now: () => number;
  readonly readDir: (dir: string) => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<string>;
  readonly pidAlive: (pid: number) => boolean;
  readonly isSocket: (path: string) => Promise<boolean>;
  /** Writes the line and reports `ok` when nothing went wrong for `ACCEPT_WAIT_MS`. A failure before the write is `retry: true`, one after it is not. */
  readonly send: (socketPath: string, line: string) => Promise<SendResult>;
};

export const claudeCapabilities: Capabilities = { push: true, wakesIdle: true, joinsTurn: false, certainty: "accepted" };

export function sendLine(socketPath: string, line: string, waitMs: number = ACCEPT_WAIT_MS): Promise<SendResult> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let timer: NodeJS.Timeout | undefined;
    // Set when the line is handed to the socket: from then on the session may have it, whatever happens next.
    let written = false;
    const failed = (what: string): SendResult =>
      written ? { ok: false, retry: false, detail: `outcome unknown, the line may have reached the session: ${what}` } : { ok: false, retry: true, detail: what };
    const end = (result: SendResult): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const limit = setTimeout(() => end(failed("the socket did not accept a connection")), CONNECT_LIMIT_MS);
    socket.once("connect", () => {
      clearTimeout(limit);
      written = true;
      socket.write(line, (error) => {
        if (error) end(failed(`write failed: ${error.message}`));
        else timer = setTimeout(() => end({ ok: true }), waitMs);
      });
    });
    socket.once("error", (error) => {
      clearTimeout(limit);
      end(failed(`socket error: ${error.message}`));
    });
    socket.once("close", () => {
      clearTimeout(limit);
      end(failed("the session closed the socket"));
    });
  });
}

export function nodeClaudeEnv(dir: string = join(homedir(), ".claude", "sessions")): ClaudeEnv {
  return {
    dir,
    now: Date.now,
    readDir: (d) => readdir(d),
    readFile: (p) => readFile(p, "utf8"),
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        // EPERM: the process exists and belongs to someone else.
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    isSocket: async (p) => {
      try {
        return (await stat(p)).isSocket();
      } catch {
        return false;
      }
    },
    send: (p, line) => sendLine(p, line),
  };
}

async function readRecord(env: ClaudeEnv, file: string): Promise<SessionRecord | null> {
  let json: unknown;
  try {
    json = JSON.parse(await env.readFile(join(env.dir, file)));
  } catch {
    return null;
  }
  const parsed = record.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Live sessions: a record that parses, a process that runs and a socket that exists. */
async function liveRecords(env: ClaudeEnv): Promise<readonly SessionRecord[]> {
  let names: readonly string[];
  try {
    names = await env.readDir(env.dir);
  } catch {
    return [];
  }
  const records = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => readRecord(env, n)));
  const found: SessionRecord[] = [];
  for (const r of records) {
    if (r && env.pidAlive(r.pid) && (await env.isSocket(r.messagingSocketPath))) found.push(r);
  }
  return found;
}

function activity(r: SessionRecord, now: number): Seen["activity"] {
  if (r.status === "busy") return "busy";
  if (r.status === "idle") return r.statusUpdatedAt != null && now - r.statusUpdatedAt > COLD_AFTER_MS ? "cold" : "idle";
  return "unknown";
}

const seen = (r: SessionRecord, now: number): Seen => ({ session: r.sessionId, title: r.name ?? null, activity: activity(r, now) });

export function createClaudeDriver(env: ClaudeEnv = nodeClaudeEnv()): Driver {
  const find = async (session: string): Promise<SessionRecord | null> =>
    (await liveRecords(env)).find((r) => r.sessionId === session) ?? null;

  return {
    product: "claude",
    capabilities: () => claudeCapabilities,
    list: async () => (await liveRecords(env)).map((r) => seen(r, env.now())),
    status: async (session) => {
      const r = await find(session);
      return r ? seen(r, env.now()) : null;
    },
    deliver: async (session, text): Promise<Delivered> => {
      const r = await find(session);
      if (!r) return { ok: false, retry: false, detail: "the session is not running here" };
      if (r.peerProtocol !== SUPPORTED_PEER_PROTOCOL) {
        return {
          ok: false,
          retry: false,
          detail: `this Claude Code speaks peer protocol ${String(r.peerProtocol ?? "none")}, the driver knows ${SUPPORTED_PEER_PROTOCOL}`,
        };
      }
      const line = `${JSON.stringify({ type: "user", message: { role: "user", content: text }, from: FROM })}\n`;
      const sent = await env.send(r.messagingSocketPath, line);
      return sent.ok ? { ok: true, certainty: "accepted" } : { ok: false, retry: sent.retry, detail: sent.detail };
    },
  };
}
