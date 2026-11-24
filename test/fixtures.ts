import { bodyFacts } from "../src/core/body.js";
import type { Address, Event, Message, Tracked } from "../src/core/types.js";

export const addr = (container: string, session = "s1", product: Address["product"] = "fake"): Address => ({ container, product, session });

export function message(id = "m1", changes: Partial<Message> = {}): Message {
  const body = changes.body ?? "hello";
  const facts = bodyFacts(body);
  return {
    id,
    thread: "t1",
    hop: 0,
    replyTo: null,
    from: { ...addr("alpha"), title: "Alpha work" },
    to: addr("beta"),
    body,
    bodyChars: facts.chars,
    bodySha256: facts.sha256,
    createdAt: 1000,
    expiresAt: 100_000,
    ...changes,
  };
}

export function tracked(state: Tracked["state"], changes: Partial<Tracked> = {}): Tracked {
  return { message: message(), state, attempts: 0, pulled: false, reason: null, certainty: null, updatedAt: 1000, ...changes };
}

export const events: Record<Event["kind"], Event> = {
  refuse: { kind: "refuse", reason: { kind: "stopped" } },
  hold: { kind: "hold" },
  approve: { kind: "approve" },
  queue: { kind: "queue" },
  "hand-out": { kind: "hand-out", attempt: 1 },
  pull: { kind: "pull" },
  deliver: { kind: "deliver", certainty: "accepted" },
  retry: { kind: "retry", reason: { kind: "driver", detail: "busy" } },
  expire: { kind: "expire" },
};
