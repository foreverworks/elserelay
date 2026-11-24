import { spawn } from "node:child_process";
import { KILL_GRACE_MS, MAX_ANSWER_BYTES } from "./command.js";
import type { Child, ChildResult, Spawn, StopWhy } from "./command.js";

const MAX_STDERR_BYTES = 4096;
export const DRAIN_MS = 1000;

export type SpawnOptions = {
  readonly graceMs?: number;
  readonly maxStdoutBytes?: number;
  /** How long the output pipes are read after the program itself has ended, before they are closed on whoever still holds them. */
  readonly drainMs?: number;
};

const SIGNALS: Readonly<Record<StopWhy, NodeJS.Signals>> = { moot: "SIGTERM", shutdown: "SIGINT" };

/**
 * Starts a program directly, without a shell, with exactly the environment it is given.
 *
 * The program is the leader of a process group of its own, and a stop is sent to that whole group, so a helper it started does not
 * outlive it. The group is signalled only while the program itself has not been reaped: after that its id may mean something else.
 * The result is ready when the program has ended and its output had a moment to arrive, not when every holder of its pipes has
 * closed them, so a helper that keeps the output open cannot wedge the slot or the shutdown.
 */
export function nodeSpawn(options: SpawnOptions = {}): Spawn {
  const graceMs = options.graceMs ?? KILL_GRACE_MS;
  const maxStdout = options.maxStdoutBytes ?? MAX_ANSWER_BYTES;
  const drainMs = options.drainMs ?? DRAIN_MS;
  return (argv, env, input): Child => {
    const [program, ...args] = argv;
    if (program === undefined) return { done: Promise.resolve({ ok: false, why: "no program", stderr: "" }), stop: () => undefined };
    let stopped = false;
    let tooLong = false;
    let killTimer: NodeJS.Timeout | undefined;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;

    let proc;
    try {
      proc = spawn(program, args, { env: { ...env }, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: true });
    } catch {
      return { done: Promise.resolve({ ok: false, why: "could not start", stderr: "" }), stop: () => undefined };
    }

    /** The program is running and has not been reaped, so its id and its group are still its own. */
    const live = (): boolean => proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null;
    const signal = (name: NodeJS.Signals): void => {
      if (!live() || proc.pid === undefined) return;
      try {
        process.kill(-proc.pid, name);
      } catch {
        // The group is gone, or could not be made: the program alone.
        try {
          proc.kill(name);
        } catch {
          // Already ended.
        }
      }
    };

    const stop = (why: StopWhy): void => {
      if (stopped || !live()) return;
      stopped = true;
      signal(SIGNALS[why]);
      killTimer = setTimeout(() => signal("SIGKILL"), graceMs);
    };

    const done = new Promise<ChildResult>((resolve) => {
      let spawnFailed = false;
      let settled = false;
      let drain: NodeJS.Timeout | undefined;
      let ended: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (drain !== undefined) clearTimeout(drain);
        // Whoever still holds the other end of a pipe is let go of: nothing more is read.
        proc.stdout.destroy();
        proc.stderr.destroy();
        const stderr = Buffer.concat(err).toString("utf8");
        if (spawnFailed || ended === undefined) return resolve({ ok: false, why: "could not start", stderr });
        if (tooLong) return resolve({ ok: false, why: "output too long", stderr });
        if (stopped) return resolve({ ok: false, why: "stopped", stderr });
        if (ended.signal !== null) return resolve({ ok: false, why: `ended by ${ended.signal}`, stderr });
        if (ended.code !== 0) return resolve({ ok: false, why: `exit code ${ended.code ?? "none"}`, stderr });
        const stdout = Buffer.concat(out).toString("utf8");
        resolve(stdout.trim() === "" ? { ok: false, why: "no output", stderr } : { ok: true, stdout, stderr });
      };
      proc.on("error", () => {
        spawnFailed = true;
        settle();
      });
      proc.on("exit", (code, sig) => {
        ended = { code, signal: sig };
        if (killTimer !== undefined) clearTimeout(killTimer);
        drain = setTimeout(settle, drainMs);
      });
      // Every pipe closed: nothing more can arrive, so there is nothing to wait for.
      proc.on("close", settle);
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        if (!tooLong) {
          tooLong = true;
          stop("moot");
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
