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
import type { ApprovalRequest, Service } from "./service.js";

export const MAX_ANSWER_BYTES = 64 * 1024;
export const MAX_CHILDREN = 16;
export const RETRY_FIRST_MS = 30_000;
export const RETRY_MAX_MS = 300_000;
export const KILL_GRACE_MS = 5000;
export const STATE_DIR_VARIABLE = "AGENT_GATEWAY_APPROVER_STATE_DIR";

export type ChildResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly why: string; readonly stderr: string };

/** A running program. `stop` is idempotent: SIGTERM now, SIGKILL after the grace, always to the child's own PID. */
export type Child = { readonly done: Promise<ChildResult>; readonly stop: () => void };
export type Spawn = (argv: readonly string[], env: Readonly<Record<string, string>>, input: string) => Child;
/** Runs `fn` once after `ms`; the returned function cancels it. */
export type After = (ms: number, fn: () => void) => () => void;

export type Timing = { readonly retryFirstMs: number; readonly retryMaxMs: number; readonly maxChildren: number };
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

/** `approve`, `refuse`, or null for anything that is not exactly one such answer. */
export function parseAnswer(stdout: string): "approve" | "refuse" | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const answer = (json as Record<string, unknown>)["answer"];
  return answer === "approve" || answer === "refuse" ? answer : null;
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

export function makeCommandApprover(deps: CommandDeps): Approver {
  const { service, spawn, after, now, log } = deps;
  const timing = deps.timing ?? defaultTiming;
  const env = childEnv(deps.env, deps.passEnv, deps.stateDir);
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  const running = new Set<Promise<unknown>>();
  let closed = false;

  const forget = (entry: Entry): void => {
    if (entries.get(entry.request.id) !== entry) return;
    entries.delete(entry.request.id);
    entry.cancelDeadline();
    entry.cancelRetry?.();
    entry.child?.stop();
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
    const settled = child.done.then((result) => finished(entry, result));
    running.add(settled);
    void settled.finally(() => {
      running.delete(settled);
      pump();
    });
  }

  function finished(entry: Entry, result: ChildResult): void {
    const { id } = entry.request;
    entry.child = null;
    if (entries.get(id) !== entry) return; // stopped meanwhile: the message is no longer ours to answer
    stderrLines(id, result.stderr);
    const answer = result.ok ? parseAnswer(result.stdout) : null;
    if (answer === null) {
      entry.failures += 1;
      const delay = retryDelay(entry.failures, timing.retryFirstMs, timing.retryMaxMs);
      log(`approver command gave no answer for message ${id} (${result.ok ? "its output was not an answer" : result.why}); trying again in ${Math.round(delay / 1000)} s while it is held`);
      entry.phase = "backoff";
      entry.cancelRetry = after(delay, () => {
        entry.cancelRetry = null;
        if (entries.get(id) !== entry) return;
        entry.phase = "waiting";
        queue.push(entry);
        pump();
      });
      return;
    }
    const applied = answer === "approve" ? service.approve(id) : service.refuse(id);
    log(
      applied.ok
        ? `approver command ${answer === "approve" ? "approved" : "refused"} message ${id}`
        : `approver command answered ${answer} for message ${id}, but it is not held any more (${applied.why})`,
    );
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
      for (const entry of [...entries.values()]) forget(entry);
      queue.length = 0;
      await Promise.allSettled([...running]);
    },
  };
}
