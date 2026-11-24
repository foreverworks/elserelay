#!/usr/bin/env node
/**
 * The program's one entry. It only picks a command and loads what that command
 * needs, so `hook` (run before every model call of an agent) does not pay for
 * the broker's modules.
 */
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type Io = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly now: () => number;
  /** The standard input, for `hook`. Absent means empty. */
  readonly stdin?: () => Promise<string>;
  /** For `approver`: settles when the process is told to stop. Only the program itself installs signal handlers, never a test. */
  readonly stopped?: () => Promise<"moot" | "shutdown">;
};

/** Returns the exit code. */
export async function runCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: Io): Promise<number> {
  const [command, product, ...rest] = argv;
  if (command === "hook" && product === "antigravity" && rest.length === 0) {
    const { runAntigravityHook } = await import("./hook/antigravity.js");
    return runAntigravityHook({
      env,
      readStdin: io.stdin ?? (async () => ""),
      readFile: (path) => readFile(path, "utf8"),
      fetch,
      out: (text) => io.out(text),
      err: io.err,
    });
  }
  if (command === "hook" && (product === "claude" || product === "codex") && rest.length === 0) {
    const { runIdentityHook } = await import("./hook/identity.js");
    return runIdentityHook(product, { env, readStdin: io.stdin ?? (async () => ""), out: (text) => io.out(text) });
  }
  if (command === "health") {
    const { runHealth } = await import("./health.js");
    return runHealth(argv.slice(1), env, { fetch, err: io.err });
  }
  if (command === "approver" && product === "elsewire" && rest.length === 0) {
    const { mcpTools, nodeState, runElsewireApprover } = await import("./approver/elsewire.js");
    return runElsewireApprover({
      env,
      stdin: io.stdin ?? (async () => ""),
      readToken: (path) => readFile(path, "utf8"),
      state: nodeState,
      connect: mcpTools,
      host: hostname(),
      stopped: io.stopped?.() ?? new Promise(() => undefined),
      now: io.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      out: io.out,
      err: io.err,
    });
  }
  if (command === "adapter" && argv.length === 1) {
    const { runAdapter } = await import("./adapter/main.js");
    return runAdapter(env);
  }
  const { runAdmin } = await import("./admin.js");
  return runAdmin(argv, env, io);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Only when run as the program, not when a test imports it.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    now: () => Date.now(),
    stdin: readStdin,
    // SIGTERM is how the broker says a question is over, SIGINT that it is only shutting down. A handler is set only when asked for.
    stopped: () =>
      new Promise((resolve) => {
        process.once("SIGTERM", () => resolve("moot"));
        process.once("SIGINT", () => resolve("shutdown"));
      }),
  }).then((code) => {
    process.exitCode = code;
    // A hook's stdin may stay open after its output; nothing may hold the agent up. The same goes for the short commands
    // that a supervisor waits on: an idle connection must not keep them from ending.
    if (process.argv[2] === "hook" || process.argv[2] === "approver" || process.argv[2] === "health") {
      process.stdin.destroy();
      setTimeout(() => process.exit(code), 500).unref();
    }
  });
}
