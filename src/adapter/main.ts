/**
 * The adapter's entry point, run as `elserelay adapter`. Settings come from
 * the environment only:
 *   ELSERELAY_URL         the broker's address
 *   ELSERELAY_TOKEN_FILE  a file holding the container's bearer token
 *   ELSERELAY_PRODUCT     claude, codex, antigravity, or fake for a try-out
 *   ELSERELAY_STATE_DIR   where the delivered ids are kept
 *   ELSERELAY_SESSIONS    optional, session ids separated by commas or spaces: the only sessions this adapter reports and delivers to.
 *                       Unset means every session; set but empty is an error, so a lost value never widens the list
 *   CODEX_SOCKET        codex only: the app-server's control socket
 *                       (default: $CODEX_HOME/app-server-control/app-server-control.sock)
 *   CODEX_HOME          where that default lives (default: ~/.codex)
 *   ANTIGRAVITY_SUMMARIES_DB  antigravity only: the CLI's conversation_summaries.db
 * The token is read once and never logged.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createAntigravityDriver, defaultSummariesPath, nodeAntigravityEnv } from "../drivers/antigravity.js";
import { createClaudeDriver } from "../drivers/claude.js";
import { connectUnix, createCodexDriver } from "../drivers/codex.js";
import { makeFake } from "../drivers/fake.js";
import type { Driver } from "../drivers/driver.js";
import { restrictSessions } from "./allowlist.js";
import { nodeDedupeIo } from "./dedupe.js";
import { defaultTiming, run } from "./run.js";

const PRODUCTS = ["claude", "codex", "antigravity", "fake"] as const;

const env = z.object({
  ELSERELAY_URL: z.url(),
  ELSERELAY_TOKEN_FILE: z.string().min(1),
  ELSERELAY_PRODUCT: z.enum(PRODUCTS),
  ELSERELAY_STATE_DIR: z.string().min(1),
  ELSERELAY_SESSIONS: z
    .string()
    .transform((list) => list.split(/[\s,]+/).filter((id) => id !== ""))
    .pipe(z.array(z.string()).min(1, "name at least one session id, or leave it unset"))
    .optional(),
  CODEX_SOCKET: z.string().min(1).optional(),
  CODEX_HOME: z.string().min(1).optional(),
  ANTIGRAVITY_SUMMARIES_DB: z.string().min(1).optional(),
});

export type Config = {
  readonly url: string;
  readonly tokenFile: string;
  readonly product: (typeof PRODUCTS)[number];
  readonly stateDir: string;
  /** The session ids this adapter may serve, or null for every session its product has. */
  readonly sessions: readonly string[] | null;
  readonly codexSocket: string;
  readonly antigravityDb: string;
};

export function readConfig(source: Readonly<Record<string, string | undefined>>, home: string = homedir()): Config | string {
  // An empty variable is as good as an unset one, so a unit file may name it without a value. The exception is the session list: an
  // adapter that was meant to serve a few sessions must not serve all of them because the value was lost on the way.
  const present = Object.fromEntries(Object.entries(source).filter(([k, v]) => v !== undefined && (v !== "" || k === "ELSERELAY_SESSIONS")));
  const parsed = env.safeParse(present);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  const e = parsed.data;
  return {
    url: e.ELSERELAY_URL,
    tokenFile: e.ELSERELAY_TOKEN_FILE,
    product: e.ELSERELAY_PRODUCT,
    stateDir: e.ELSERELAY_STATE_DIR,
    sessions: e.ELSERELAY_SESSIONS ?? null,
    codexSocket: e.CODEX_SOCKET ?? join(e.CODEX_HOME ?? join(home, ".codex"), "app-server-control", "app-server-control.sock"),
    antigravityDb: e.ANTIGRAVITY_SUMMARIES_DB ?? defaultSummariesPath(home),
  };
}

/** What the adapter logs at start, so the operator can see at once whether the list was read as meant. */
export const servingLine = (config: Config): string =>
  config.sessions === null ? `serving every ${config.product} session` : `serving only these sessions: ${config.sessions.join(", ")}`;

export function driverFor(config: Config, log: (line: string) => void): Driver {
  const driver = productDriver(config, log);
  return config.sessions === null ? driver : restrictSessions(driver, config.sessions);
}

function productDriver(config: Config, log: (line: string) => void): Driver {
  switch (config.product) {
    case "claude":
      return createClaudeDriver();
    case "codex":
      return createCodexDriver({ connect: connectUnix(config.codexSocket) });
    case "antigravity":
      return createAntigravityDriver(nodeAntigravityEnv(config.antigravityDb, log));
    case "fake":
      return makeFake().driver;
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Runs until SIGINT or SIGTERM and returns the exit code. */
export async function runAdapter(source: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const config = readConfig(source);
  if (typeof config === "string") {
    process.stderr.write(`elserelay adapter: bad settings: ${config}\n`);
    return 2;
  }
  let token: string;
  try {
    token = (await readFile(config.tokenFile, "utf8")).trim();
  } catch {
    process.stderr.write(`elserelay adapter: cannot read the token file ${config.tokenFile}\n`);
    return 2;
  }
  if (token === "") {
    process.stderr.write(`elserelay adapter: the token file ${config.tokenFile} is empty\n`);
    return 2;
  }
  const log = (line: string): void => {
    process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  };
  log(servingLine(config));
  const stop = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => stop.abort());
  const end = await run(
    {
      url: config.url,
      token,
      driver: driverFor(config, log),
      dedupePath: join(config.stateDir, "delivered.json"),
      dedupeIo: nodeDedupeIo,
      fetch,
      sleep,
      now: Date.now,
      random: Math.random,
      log,
      timing: defaultTiming,
    },
    stop.signal,
  );
  if (end.reason === "unauthorized") {
    process.stderr.write(`elserelay adapter: ${end.message}\n`);
    return 1;
  }
  return 0;
}
