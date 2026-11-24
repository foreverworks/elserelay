/**
 * The command approver: for every held message the broker starts a program of
 * the operator's, writes the request on its standard input as one JSON object,
 * and reads one JSON line back, `{"answer":"approve"}` or `{"answer":"refuse"}`.
 * Anything else is no answer. The message then stays held for the command line
 * and the command is tried again, until the message stops being held.
 *
 * Every effect (starting a program, the clock, timers, the log) is handed in.
 * The state is one map of what is being asked, owned by the closure.
 */
import type { Approver } from "./approver.js";
import { escapeForTerminal } from "./approver.js";
import { REFUSAL_CODES } from "./service.js";
import type { Answered, ApprovalRequest, RefusalCode, Service } from "./service.js";

export const MAX_ANSWER_BYTES = 64 * 1024;
export const MAX_CHILDREN = 16;
export const RETRY_FIRST_MS = 30_000;
export const RETRY_MAX_MS = 300_000;
export const KILL_GRACE_MS = 5000;
export const STATE_DIR_VARIABLE = "ELSERELAY_APPROVER_STATE_DIR";

export type ChildResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly why: string; readonly stderr: string };

/**
 * Why a program is stopped, told to it by the signal: `moot` (SIGTERM) means its question is over, because the message was answered
 * elsewhere, reached its deadline or is not held any more, so it should withdraw what it asked; `shutdown` (SIGINT) means only the
 * broker is going away, the message is still held and the program should leave its question as it is for the next broker to pick up.
 */
export type StopWhy = "moot" | "shutdown";

/** A running program. `stop` is idempotent, the first reason wins: the signal now, SIGKILL after the grace. */
export type Child = { readonly done: Promise<ChildResult>; readonly stop: (why: StopWhy) => void };
export type Spawn = (argv: readonly string[], env: Readonly<Record<string, string>>, input: string) => Child;
/** Runs `fn` once after `ms`; the returned function cancels it. */
export type After = (ms: number, fn: () => void) => () => void;

export type Timing = {
  readonly retryFirstMs: number;
  readonly retryMaxMs: number;
  readonly maxChildren: number;
  /** How many more times an answer is written when the store was busy, and the wait before the first of them (it doubles). */
  readonly answerRetries?: number;
  readonly answerBackoffMs?: number;
};
export const ANSWER_RETRIES = 4;
export const ANSWER_BACKOFF_MS = 250;
export const defaultTiming: Timing = { retryFirstMs: RETRY_FIRST_MS, retryMaxMs: RETRY_MAX_MS, maxChildren: MAX_CHILDREN };

export type CommandDeps = {
  readonly argv: readonly string[];
  readonly stateDir?: string;
  readonly passEnv: readonly string[];
  /** The broker's own environment: only PATH, HOME, LANG and the names in `passEnv` are taken from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly service: Pick<Service, "approve" | "refuse">;
  readonly spawn: Spawn;
  readonly after: After;
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly timing?: Timing;
};

/** What the command is told. Listed field by field, so nothing the broker adds to a request later reaches a program. */
export function requestJson(request: ApprovalRequest): string {
  const { from, to } = request;
  return JSON.stringify({
    id: request.id,
    thread: request.thread,
    hop: request.hop,
    from: { container: from.container, product: from.product, session: from.session, title: from.title },
    to: { container: to.container, product: to.product, session: to.session },
    body: request.body,
    rule: request.rule,
    heldAt: request.heldAt,
    decideBy: request.decideBy,
  });
}

/** The program's whole environment, so the broker's own secrets stay with the broker. */
export function childEnv(
  source: Readonly<Record<string, string | undefined>>,
  passEnv: readonly string[],
  stateDir: string | undefined,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "LANG", ...passEnv]) {
    const value = source[name];
    if (value !== undefined) out[name] = value;
  }
  if (stateDir !== undefined) out[STATE_DIR_VARIABLE] = stateDir;
  return out;
}

/** What a program may answer. `reason` is only for a refusal, and only one of `REFUSAL_CODES`. */
export type Answer = { readonly answer: "approve" } | { readonly answer: "refuse"; readonly reason?: RefusalCode };

/** An approve, a refuse (with one of the fixed reason codes, or none), or null for anything else. */
export function parseAnswer(stdout: string): Answer | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const { answer, reason } = json as Record<string, unknown>;
  if (answer === "approve") return reason === undefined ? { answer } : null;
  if (answer !== "refuse") return null;
  if (reason === undefined) return { answer };
  const code = REFUSAL_CODES.find((c) => c === reason);
  return code === undefined ? null : { answer, reason: code };
}

/** 30 s for the first retry, doubling, never more than `max`. `attempts` is how many runs have ended without an answer. */
export const retryDelay = (attempts: number, first: number, max: number): number => Math.min(max, first * 2 ** Math.max(0, attempts - 1));

type Entry = {
  readonly request: ApprovalRequest;
  /** Runs that ended without an answer. */
  failures: number;
  phase: "waiting" | "running" | "backoff";
  child: Child | null;
  cancelRetry: (() => void) | null;
  readonly cancelDeadline: () => void;
};

const oneLine = (text: string): string => escapeForTerminal(text).replace(/\n/g, " ");
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "error");

export function makeCommandApprover(deps: CommandDeps): Approver {
  const { service, spawn, after, now, log } = deps;
  const timing = deps.timing ?? defaultTiming;
  const answerRetries = timing.answerRetries ?? ANSWER_RETRIES;
  const answerBackoffMs = timing.answerBackoffMs ?? ANSWER_BACKOFF_MS;
  const env = childEnv(deps.env, deps.passEnv, deps.stateDir);
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  const running = new Set<Promise<unknown>>();
  let closed = false;

  const forget = (entry: Entry, why: StopWhy = "moot"): void => {
    if (entries.get(entry.request.id) !== entry) return;
    entries.delete(entry.request.id);
    entry.cancelDeadline();
    entry.cancelRetry?.();
    entry.child?.stop(why);
  };

  const stderrLines = (id: string, stderr: string): void => {
    for (const line of stderr.split("\n")) if (line.trim() !== "") log(`approver command for message ${id}: ${oneLine(line.trim()).slice(0, 500)}`);
  };

  const pump = (): void => {
    while (!closed && running.size < timing.maxChildren) {
      const entry = queue.shift();
      if (entry === undefined) return;
      if (entries.get(entry.request.id) === entry && entry.phase === "waiting") start(entry);
    }
  };

  function start(entry: Entry): void {
    entry.phase = "running";
    const child = spawn(deps.argv, env, requestJson(entry.request));
    entry.child = child;
    // Nothing that goes wrong in here may escape as a rejection: it would end the broker. The entry is never left in `running`.
    const settled = child.done
      .then((result) => finished(entry, result))
      .catch((error: unknown) => {
        entry.child = null;
        if (entries.get(entry.request.id) === entry) noAnswer(entry, `an internal error (${errorName(error)})`);
      });
    running.add(settled);
    void settled.finally(() => {
      running.delete(settled);
      pump();
    });
  }

  /** The message stays held: the program is run again after a wait that grows, until the message stops being held. */
  function noAnswer(entry: Entry, why: string): void {
    const { id } = entry.request;
    entry.failures += 1;
    const delay = retryDelay(entry.failures, timing.retryFirstMs, timing.retryMaxMs);
    log(`approver command gave no answer for message ${id} (${why}); trying again in ${Math.round(delay / 1000)} s while it is held`);
    entry.phase = "backoff";
    entry.cancelRetry = after(delay, () => {
      entry.cancelRetry = null;
      if (entries.get(id) !== entry) return;
      entry.phase = "waiting";
      queue.push(entry);
      pump();
    });
  }

  function finished(entry: Entry, result: ChildResult): void {
    const { id } = entry.request;
    entry.child = null;
    if (entries.get(id) !== entry) return; // stopped meanwhile: the message is no longer ours to answer
    stderrLines(id, result.stderr);
    const answer = result.ok ? parseAnswer(result.stdout) : null;
    if (answer === null) return noAnswer(entry, result.ok ? "its output was not an answer" : result.why);
    apply(entry, answer, 0);
  }

  /**
   * Writes the program's answer. A write lost to a busy store is tried again a few times with a short wait, because a real yes
   * must not be dropped; if the store stays busy the answer counts as none and the program is run again as usual.
   */
  function apply(entry: Entry, answer: Answer, retried: number): void {
    const { id } = entry.request;
    if (entries.get(id) !== entry) return;
    let applied: Answered;
    try {
      applied = answer.answer === "approve" ? service.approve(id) : service.refuse(id, answer.reason);
    } catch (error) {
      log(`approver command answered ${answer.answer} for message ${id}, but the store failed (${errorName(error)})`);
      applied = { ok: false, why: "busy" };
    }
    if (!applied.ok && applied.why === "busy") {
      if (retried >= answerRetries) return noAnswer(entry, "the store stayed busy, so its answer could not be written");
      entry.phase = "backoff";
      entry.cancelRetry = after(answerBackoffMs * 2 ** retried, () => {
        entry.cancelRetry = null;
        apply(entry, answer, retried + 1);
      });
      return;
    }
    const word = answer.answer === "approve" ? "approved" : "refused";
    log(applied.ok ? `approver command ${word} message ${id}` : `approver command answered ${answer.answer} for message ${id}, but it is not held any more (${applied.why})`);
    forget(entry);
  }

  return {
    ask: (request) => {
      if (closed || entries.has(request.id)) return Promise.resolve();
      const entry: Entry = {
        request,
        failures: 0,
        phase: "waiting",
        child: null,
        cancelRetry: null,
        cancelDeadline: after(Math.max(0, request.decideBy - now()), () => {
          // From here a yes is a refusal anyway: the command is not waited for.
          log(`message ${request.id} reached its deadline; the approver command is stopped`);
          forget(entry);
        }),
      };
      entries.set(request.id, entry);
      queue.push(entry);
      pump();
      return Promise.resolve();
    },

    sync: (heldIds) => {
      for (const entry of [...entries.values()]) if (!heldIds.has(entry.request.id)) forget(entry);
    },

    close: async () => {
      closed = true;
      // The messages are still held: the programs are only told the broker is going away, so what they asked stays open for the next broker.
      for (const entry of [...entries.values()]) forget(entry, "shutdown");
      queue.length = 0;
      await Promise.allSettled([...running]);
    },
  };
}
