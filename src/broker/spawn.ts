import { spawn } from "node:child_process";
import { KILL_GRACE_MS, MAX_ANSWER_BYTES } from "./command.js";
import type { Child, ChildResult, Spawn } from "./command.js";

const MAX_STDERR_BYTES = 4096;

export type SpawnOptions = { readonly graceMs?: number; readonly maxStdoutBytes?: number };

/** Starts a program directly, without a shell, with exactly the environment it is given. */
export function nodeSpawn(options: SpawnOptions = {}): Spawn {
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const maxStdout = options.maxStdoutBytes ?? MAX_ANSWER_BYTES;
  return (argv, env, input): Child => {
    const [program, ...args] = argv;
    if (program === undefined) return { done: Promise.resolve({ ok: false, why: "no program", stderr: "" }), stop: () => undefined };
    let stopped = false;
    let tooLong = false;
    let exited = false;
    let killTimer: NodeJS.Timeout | undefined;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;

    let proc;
    try {
      proc = spawn(program, args, { env: { ...env }, stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch {
      return { done: Promise.resolve({ ok: false, why: "could not start", stderr: "" }), stop: () => undefined };
    }

    const stop = (): void => {
      if (stopped || exited) return;
      stopped = true;
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!exited) proc.kill("SIGKILL");
      }, graceMs);
    };

    const done = new Promise<ChildResult>((resolve) => {
      let spawnFailed = false;
      proc.on("error", () => {
        spawnFailed = true;
      });
      proc.on("close", (code, signal) => {
        exited = true;
        if (killTimer !== undefined) clearTimeout(killTimer);
        const stderr = Buffer.concat(err).toString("utf8");
        if (spawnFailed) return resolve({ ok: false, why: "could not start", stderr });
        if (tooLong) return resolve({ ok: false, why: "output too long", stderr });
        if (stopped) return resolve({ ok: false, why: "stopped", stderr });
        if (signal !== null) return resolve({ ok: false, why: `ended by ${signal}`, stderr });
        if (code !== 0) return resolve({ ok: false, why: `exit code ${code ?? "none"}`, stderr });
        const stdout = Buffer.concat(out).toString("utf8");
        resolve(stdout.trim() === "" ? { ok: false, why: "no output", stderr } : { ok: true, stdout, stderr });
      });
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        if (!tooLong) {
          tooLong = true;
          stop();
        }
        return;
      }
      out.push(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (errBytes >= MAX_STDERR_BYTES) return;
      errBytes += chunk.length;
      err.push(chunk);
    });
    // A program that exits without reading its input closes the pipe under us; that is its answer to give, not ours to fail on.
    proc.stdin.on("error", () => undefined);
    proc.stdin.end(input);
    return { done, stop };
  };
}
