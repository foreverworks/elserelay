/**
 * The loop that runs beside an agent: it dials the broker, tells it which
 * sessions exist, and hands each message it is sent to the product's driver.
 * Everything that touches the world (network, clock, files, randomness) comes in
 * through `RunDeps`.
 */
import { OUTCOME_PATH, REPORT_PATH, STREAM_PATH } from "../wire.js";
import type { AdapterReport, Outcome, ToAdapter } from "../wire.js";
import type { Delivered, Driver } from "../drivers/driver.js";
import { DEFAULT_LIMIT, loadDedupe, lookup, remember, saveDedupe } from "./dedupe.js";
import type { DedupeIo, DedupeState } from "./dedupe.js";
import { emptySse, feedSse } from "./sse.js";

export type Timing = {
  /** No data for this long and the connection is dead. */
  readonly deadMs: number;
  /** The report is posted at least this often. */
  readonly reportEveryMs: number;
  /** How often the driver is asked for its sessions. */
  readonly pollMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** How many times one outcome is posted before the broker's own resend takes over. */
  readonly postAttempts: number;
};

export const defaultTiming: Timing = {
  deadMs: 60_000,
  reportEveryMs: 30_000,
  pollMs: 5_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  postAttempts: 8,
};

export type RunDeps = {
  /** The broker's address, without the path. */
  readonly url: string;
  readonly token: string;
  readonly driver: Driver;
  readonly dedupePath: string;
  readonly dedupeIo: DedupeIo;
  readonly fetch: typeof fetch;
  /** Resolves true when the time is up, false when the signal ended first; never rejects. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<boolean>;
  readonly now: () => number;
  /** In [0, 1). */
  readonly random: () => number;
  readonly log: (line: string) => void;
  readonly timing: Timing;
  readonly dedupeLimit?: number;
};

export type RunEnd =
  | { readonly reason: "stopped" }
  | { readonly reason: "unauthorized"; readonly message: string };

type Deliver = Extract<ToAdapter, { readonly kind: "deliver" }>;
type Post = "ok" | "retry" | "drop";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function run(deps: RunDeps, signal: AbortSignal): Promise<RunEnd> {
  const { driver, timing } = deps;
  const limit = deps.dedupeLimit ?? DEFAULT_LIMIT;
  const base = deps.url.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${deps.token}` };

  // Ends everything: the caller's signal, or a refused token.
  const stop = new AbortController();
  const onAbort = (): void => stop.abort();
  if (signal.aborted) stop.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  let unauthorized = false;
  const refused = (): void => {
    unauthorized = true;
    stop.abort();
  };

  let dedupe: DedupeState = await loadDedupe(deps.dedupeIo, deps.dedupePath, limit);
  let saving: Promise<void> = Promise.resolve();
  const persist = (state: DedupeState): Promise<void> => {
    saving = saving
      .then(() => saveDedupe(deps.dedupeIo, deps.dedupePath, state))
      .catch((e: unknown) => deps.log(`could not save the delivered ids: ${message(e)}`));
    return saving;
  };

  const backoff = (attempt: number): number => {
    const ceiling = Math.min(timing.backoffMaxMs, timing.backoffBaseMs * 2 ** attempt);
    return ceiling * (0.5 + deps.random() / 2);
  };

  const post = async (path: string, body: unknown, sig: AbortSignal): Promise<Post> => {
    try {
      const res = await deps.fetch(base + path, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: sig,
      });
      await res.body?.cancel();
      if (res.ok) return "ok";
      if (res.status === 401) {
        refused();
        return "drop";
      }
      if (res.status === 408 || res.status === 429 || res.status >= 500) return "retry";
      deps.log(`${path} answered ${res.status}; not trying again`);
      return "drop";
    } catch (e) {
      if (sig.aborted) return "drop";
      deps.log(`${path} failed: ${message(e)}`);
      return "retry";
    }
  };

  const postOutcome = async (outcome: Outcome): Promise<void> => {
    for (let i = 0; i < timing.postAttempts && !stop.signal.aborted; i++) {
      const r = await post(OUTCOME_PATH, outcome, stop.signal);
      if (r !== "retry") return;
      await deps.sleep(backoff(i), stop.signal);
    }
  };

  const handle = async (ev: Deliver): Promise<void> => {
    if (stop.signal.aborted) return;
    const known = lookup(dedupe, ev.id);
    if (known) {
      await postOutcome({ id: ev.id, attempt: ev.attempt, result: known });
      return;
    }
    let result: Delivered;
    try {
      result = await driver.deliver(ev.to.session, ev.text);
    } catch (e) {
      result = { ok: false, retry: true, detail: `driver error: ${message(e)}` };
    }
    if (result.ok) {
      dedupe = remember(dedupe, ev.id, result, limit);
      await persist(dedupe);
    }
    await postOutcome({ id: ev.id, attempt: ev.attempt, result });
  };

  // One delivery at a time per session, sessions in parallel.
  const tails = new Map<string, Promise<void>>();
  const inflight = new Set<Promise<void>>();
  const enqueue = (ev: Deliver): void => {
    const key = ev.to.session;
    const task: Promise<void> = (tails.get(key) ?? Promise.resolve())
      .then(() => handle(ev))
      .catch((e: unknown) => deps.log(`delivery ${ev.id} failed: ${message(e)}`))
      .finally(() => {
        inflight.delete(task);
        if (tails.get(key) === task) tails.delete(key);
      });
    tails.set(key, task);
    inflight.add(task);
  };

  const reportLoop = async (sig: AbortSignal): Promise<void> => {
    let lastJson = "";
    let lastAt = Number.NEGATIVE_INFINITY;
    let lastFailure: string | null = null;
    while (!sig.aborted) {
      let sessions: AdapterReport["sessions"] | null = null;
      try {
        sessions = [...(await driver.list())].sort((a, b) => a.session.localeCompare(b.session));
        lastFailure = null;
      } catch (e) {
        // Nothing is posted, so the broker keeps the last list; an empty one would say every session is gone. A failure that repeats is logged once.
        if (message(e) !== lastFailure) deps.log(`could not list sessions: ${message(e)}`);
        lastFailure = message(e);
      }
      if (sessions) {
        const json = JSON.stringify(sessions);
        const at = deps.now();
        if (json !== lastJson || at - lastAt >= timing.reportEveryMs) {
          const report: AdapterReport = { product: driver.product, capabilities: driver.capabilities(), sessions };
          if ((await post(REPORT_PATH, report, sig)) === "ok") {
            lastJson = json;
            lastAt = at;
          }
        }
      }
      await deps.sleep(timing.pollMs, sig);
    }
  };

  /** Returns whether the broker accepted the connection. */
  const connectOnce = async (): Promise<boolean> => {
    const conn = new AbortController();
    const sig = AbortSignal.any([stop.signal, conn.signal]);
    let reporter: Promise<void> = Promise.resolve();
    let connected = false;
    try {
      const res = await deps.fetch(base + STREAM_PATH, { headers: { ...auth, accept: "text/event-stream" }, signal: sig });
      if (res.status === 401) {
        refused();
        await res.body?.cancel();
        return false;
      }
      if (!res.ok || !res.body) {
        deps.log(`stream answered ${res.status}`);
        await res.body?.cancel();
        return false;
      }
      connected = true;
      deps.log("connected");
      reporter = reportLoop(sig);
      const reader = res.body.getReader();
      let sse = emptySse;
      for (;;) {
        const tick = new AbortController();
        const chunk = await Promise.race([
          reader.read(),
          deps.sleep(timing.deadMs, tick.signal).then(() => "dead" as const),
        ]).finally(() => tick.abort());
        if (chunk === "dead") {
          deps.log(`no data for ${timing.deadMs} ms; reconnecting`);
          break;
        }
        if (chunk.done) {
          deps.log("stream ended");
          break;
        }
        const fed = feedSse(sse, chunk.value);
        sse = fed.state;
        for (const ev of fed.events) if (ev.kind === "deliver") enqueue(ev);
      }
      return true;
    } catch (e) {
      if (!stop.signal.aborted) deps.log(`stream failed: ${message(e)}`);
      return connected;
    } finally {
      conn.abort();
      await reporter;
    }
  };

  let failures = 0;
  while (!stop.signal.aborted) {
    const connected = await connectOnce();
    if (stop.signal.aborted) break;
    failures = connected ? 0 : failures + 1;
    await deps.sleep(backoff(Math.max(0, failures - 1)), stop.signal);
  }
  signal.removeEventListener("abort", onAbort);
  await Promise.allSettled([...inflight]);
  await saving;
  return unauthorized
    ? { reason: "unauthorized", message: "The broker refused the token (401). Check ELSERELAY_TOKEN_FILE: the token may be wrong or revoked." }
    : { reason: "stopped" };
}
