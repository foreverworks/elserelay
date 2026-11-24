/** Small helpers the live scripts share. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `probe` every 250 ms until it returns something other than undefined or false. */
export async function until<T>(what: string, ms: number, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`);
    await sleep(250);
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

export const oneLine = (text: string, max = 400): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

export const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Runs a program with its input closed and returns what it printed; rejects on a bad exit or a timeout. */
export function capture(bin: string, args: readonly string[], env: Record<string, string>, timeoutMs: number): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(bin, [...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(oneLine(err || `exited with ${String(code)}`)))));
  });
}
