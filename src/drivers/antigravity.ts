/**
 * Antigravity. A conversation cannot be pushed to, so this driver only lists:
 * the conversations come from the CLI's summary database, read-only, and a
 * message reaches one through the hook's pull (`elserelay hook antigravity`).
 * Why is in docs/drivers/antigravity.md.
 *
 * The database is not a documented contract. Whatever is wrong with it (the
 * file, a table, a column, a row) shows as fewer sessions and one log line
 * per kind of failure, never as a crash.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Capabilities, Delivered, Driver, Seen } from "./driver.js";

const LIST_LIMIT = 50;
const COLD_AFTER_MS = 60 * 60 * 1000;

export const antigravityCapabilities: Capabilities = { push: false, wakesIdle: false, joinsTurn: false, certainty: "accepted" };

export const defaultSummariesPath = (home: string = homedir()): string => join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");

const flag = z.union([z.boolean(), z.number(), z.string()]);

// Read as untrusted: only the id is required, and every other column may be missing or typed differently from what was seen.
const row = z.object({
  conversation_id: z.string().min(1),
  title: z.string().nullish(),
  last_modified_time: z.union([z.number(), z.string()]).nullish(),
  not_fully_idle: flag.nullish(),
});

export type AntigravityEnv = {
  /** Rows of `conversation_summaries`, most recently changed first, killed ones left out. Throws when the database cannot be read. */
  readonly rows: () => readonly unknown[];
  readonly now: () => number;
  readonly log: (line: string) => void;
};

const QUERY = `SELECT conversation_id, title, last_modified_time, not_fully_idle FROM conversation_summaries
  WHERE killed = 0 OR killed = 'false' ORDER BY last_modified_time DESC LIMIT ${LIST_LIMIT}`;

export function nodeAntigravityEnv(path: string, log: (line: string) => void, now: () => number = Date.now): AntigravityEnv {
  return {
    rows: () => {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        return db.prepare(QUERY).all();
      } finally {
        db.close();
      }
    },
    now,
    log,
  };
}

/** The column holds a time as the CLI wrote it: seconds or milliseconds since the epoch, or a date string. */
function timeOf(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value > 1e11 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

const truthy = (value: z.infer<typeof flag> | null | undefined): boolean => value === true || value === 1 || value === "1" || value === "true";

function seen(r: z.infer<typeof row>, now: number): Seen {
  const changed = timeOf(r.last_modified_time);
  const activity: Seen["activity"] = changed === null ? "unknown" : now - changed > COLD_AFTER_MS ? "cold" : truthy(r.not_fully_idle) ? "busy" : "idle";
  const title = r.title === null || r.title === undefined || r.title === "" ? null : r.title;
  return { session: r.conversation_id, title, activity };
}

export function createAntigravityDriver(env: AntigravityEnv): Driver {
  let lastFailure: string | null = null;

  const list: Driver["list"] = async () => {
    let rows: readonly unknown[];
    try {
      rows = env.rows();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // The same failure on every poll is one line, not one every five seconds.
      if (why !== lastFailure) env.log(`antigravity: cannot read the conversation summaries, listing none: ${why}`);
      lastFailure = why;
      return [];
    }
    lastFailure = null;
    const now = env.now();
    return rows.flatMap((raw) => {
      const parsed = row.safeParse(raw);
      return parsed.success ? [seen(parsed.data, now)] : [];
    });
  };

  return {
    product: "antigravity",
    capabilities: () => antigravityCapabilities,
    list,
    status: async (session) => (await list()).find((s) => s.session === session) ?? null,
    deliver: async (): Promise<Delivered> => ({
      ok: false,
      retry: false,
      detail: "Antigravity cannot be pushed to; its hook collects what waits in the inbox",
    }),
  };
}
