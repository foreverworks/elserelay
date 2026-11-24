/**
 * The only legal moves of a message, as drawn in docs/design.md. A pure
 * function: it never reads a clock and never touches a store.
 */
import type { Event, State, Tracked } from "./types.js";

export type Step = { readonly ok: true; readonly next: Tracked } | { readonly ok: false; readonly why: string };

const FINAL: readonly State[] = ["delivered", "refused", "expired"];

export function isFinal(state: State): boolean {
  return FINAL.includes(state);
}

export function step(tracked: Tracked, event: Event, at: number): Step {
  const { state } = tracked;
  const go = (changes: Partial<Tracked>): Step => ({ ok: true, next: { ...tracked, ...changes, updatedAt: at } });
  const no = (): Step => ({ ok: false, why: `a message that is ${state} cannot take ${event.kind}` });

  if (isFinal(state)) return { ok: false, why: `a message that is ${state} is final and takes no event (got ${event.kind})` };

  switch (event.kind) {
    case "refuse":
      return go({ state: "refused", reason: event.reason });
    case "hold":
      return state === "received" ? go({ state: "held" }) : no();
    case "queue":
      return state === "received" ? go({ state: "queued" }) : no();
    case "approve":
      return state === "held" ? go({ state: "queued" }) : no();
    case "hand-out":
      if (state !== "queued") return no();
      // The adapter drops a repeated id by its attempt number, so a gap here is a bug upstream.
      if (event.attempt !== tracked.attempts + 1) {
        return { ok: false, why: `hand-out attempt ${event.attempt} does not follow ${tracked.attempts} earlier attempts` };
      }
      return go({ state: "delivering", attempts: event.attempt });
    case "deliver":
      return state === "delivering" ? go({ state: "delivered", certainty: event.certainty }) : no();
    case "retry":
      return state === "delivering" ? go({ state: "queued", reason: event.reason }) : no();
    case "expire":
      // A message that has only been received is decided at once, so it never waits long enough to expire.
      return state === "received" ? no() : go({ state: "expired" });
  }
}
