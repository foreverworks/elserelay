import { describe, expect, it } from "vitest";
import { isFinal, step } from "../src/core/states.js";
import { STATES } from "../src/core/types.js";
import type { Event, State } from "../src/core/types.js";
import { events, tracked } from "./fixtures.js";

// The diagram in docs/design.md: where each event leads from each state. Everything else is illegal.
const MOVES: Record<State, Partial<Record<Event["kind"], State>>> = {
  received: { refuse: "refused", hold: "held", queue: "queued" },
  held: { approve: "queued", refuse: "refused", expire: "expired" },
  queued: { hold: "held", "hand-out": "delivering", refuse: "refused", expire: "expired" },
  delivering: { deliver: "delivered", retry: "queued", refuse: "refused", expire: "expired" },
  delivered: {},
  refused: {},
  expired: {},
};

describe("step", () => {
  for (const state of STATES) {
    for (const [kind, event] of Object.entries(events)) {
      const to = MOVES[state][event.kind];
      it(`${state} + ${kind} ${to === undefined ? "is refused" : `moves to ${to}`}`, () => {
        const result = step(tracked(state), event, 5000);
        if (to === undefined) {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.why).toContain(state);
        } else {
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.next.state).toBe(to);
            expect(result.next.updatedAt).toBe(5000);
            expect(result.next.message).toEqual(tracked(state).message);
          }
        }
      });
    }
  }

  it("counts hand-outs and sets the reason on refuse and retry, the certainty on deliver", () => {
    const out = step(tracked("queued"), events["hand-out"], 2000);
    expect(out.ok && out.next.attempts).toBe(1);

    const retried = step(tracked("delivering", { attempts: 1 }), events.retry, 3000);
    expect(retried.ok && retried.next.reason).toEqual({ kind: "driver", detail: "busy" });
    expect(retried.ok && retried.next.attempts).toBe(1);

    const again = step(tracked("queued", { attempts: 1 }), { kind: "hand-out", attempt: 2 }, 4000);
    expect(again.ok && again.next.attempts).toBe(2);

    const done = step(tracked("delivering", { attempts: 2 }), { kind: "deliver", certainty: "confirmed" }, 5000);
    expect(done.ok && done.next.certainty).toBe("confirmed");

    const refused = step(tracked("held"), events.refuse, 6000);
    expect(refused.ok && refused.next.reason).toEqual({ kind: "stopped" });
  });

  it("rejects a hand-out whose attempt number does not follow the count", () => {
    for (const attempt of [0, 2, 5]) {
      expect(step(tracked("queued"), { kind: "hand-out", attempt }, 1).ok).toBe(false);
    }
  });

  it("does not change its input", () => {
    const before = tracked("queued");
    const copy = structuredClone(before);
    step(before, events["hand-out"], 9);
    expect(before).toEqual(copy);
  });
});

describe("isFinal", () => {
  it("is true for delivered, refused and expired only", () => {
    expect(STATES.filter(isFinal)).toEqual(["delivered", "refused", "expired"]);
  });
});
