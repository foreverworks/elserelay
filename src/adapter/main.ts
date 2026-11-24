/**
 * The adapter's entry point. Settings come from the environment only:
 *   GATEWAY_URL         the broker's address
 *   GATEWAY_TOKEN_FILE  a file holding the container's bearer token
 *   GATEWAY_PRODUCT     claude, or fake for a try-out
 *   GATEWAY_STATE_DIR   where the delivered ids are kept
 * The token is read once and never logged.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createClaudeDriver } from "../drivers/claude.js";
import { makeFake } from "../drivers/fake.js";
import type { Driver } from "../drivers/driver.js";
import { nodeDedupeIo } from "./dedupe.js";
import { defaultTiming, run } from "./run.js";

const env = z.object({
  GATEWAY_URL: z.url(),
  GATEWAY_TOKEN_FILE: z.string().min(1),
  GATEWAY_PRODUCT: z.enum(["claude", "fake"]),
  GATEWAY_STATE_DIR: z.string().min(1),
});

export type Config = {
  readonly url: string;
  readonly tokenFile: string;
  readonly product: "claude" | "fake";
  readonly stateDir: string;
};

export function readConfig(source: Readonly<Record<string, string | undefined>>): Config | string {
  const parsed = env.safeParse(source);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  const e = parsed.data;
  return { url: e.GATEWAY_URL, tokenFile: e.GATEWAY_TOKEN_FILE, product: e.GATEWAY_PRODUCT, stateDir: e.GATEWAY_STATE_DIR };
}

export const driverFor = (product: Config["product"]): Driver =>
  product === "claude" ? createClaudeDriver() : makeFake().driver;

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

async function main(): Promise<number> {
  const config = readConfig(process.env);
  if (typeof config === "string") {
    process.stderr.write(`agent-gateway adapter: bad settings: ${config}\n`);
    return 2;
  }
  let token: string;
  try {
    token = (await readFile(config.tokenFile, "utf8")).trim();
  } catch {
    process.stderr.write(`agent-gateway adapter: cannot read the token file ${config.tokenFile}\n`);
    return 2;
  }
  if (token === "") {
    process.stderr.write(`agent-gateway adapter: the token file ${config.tokenFile} is empty\n`);
    return 2;
  }
  const stop = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, () => stop.abort());
  const end = await run(
    {
      url: config.url,
      token,
      driver: driverFor(config.product),
      dedupePath: join(config.stateDir, "delivered.json"),
      dedupeIo: nodeDedupeIo,
      fetch,
      sleep,
      now: Date.now,
      random: Math.random,
      log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
      timing: defaultTiming,
    },
    stop.signal,
  );
  if (end.reason === "unauthorized") {
    process.stderr.write(`agent-gateway adapter: ${end.message}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
