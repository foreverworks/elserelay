/** The fixes from the second review of the broker (foreverworks/agent-gateway#5), one group each. */
import { afterEach, describe, expect, it } from "vitest";
import { HOP_MEMORY_MS, MAX_INBOX_MESSAGES, MAX_RETURNS } from "../src/broker/service.js";
import { senderText } from "../src/broker/reasons.js";
import type { Rig } from "./broker-fixtures.js";
import { ALLOW_ALL, policyOf, report, rig, seen } from "./broker-fixtures.js";

let current: Rig | undefined;
const make = (policy: unknown = ALLOW_ALL, deliveryTimeoutMs = 1000): Rig => {
  current = rig(policyOf(policy), deliveryTimeoutMs);
  const { service } = current;
  service.report("beta", report("codex", [seen("b1", "idle", "Beta one"), seen("b2", "cold")]));
  service.report("alpha", report("claude", [seen("a1", "idle", "Alpha one")]));
  return current;
};
afterEach(() => {
  current?.store.close();
  current = undefined;
});

const alpha = { session: "a1", title: "Alpha one" };
const beta = (session = "b1") => ({ session, title: null });
const to = (session = "b1", container = "beta") => ({ container, session });

const accepted = (r: { readonly kind: string; readonly id?: string }): string => {
  if (r.kind !== "accepted" || r.id === undefined) throw new Error(`not accepted: ${JSON.stringify(r)}`);
  return r.id;
};

const pulled = (r: Rig, received?: readonly string[]): string[] => {
  const got = r.service.inbox("beta", "b2", received);
  return got.kind === "ok" ? got.messages.map((m) => m.id) : [];
};

describe("1. a message nobody confirms is returned a few times, then settled", () => {
  it("returns it the allowed number of times and then counts it as delivered with certainty accepted", () => {
    const r = make();
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    expect(pulled(r)).toEqual([id]);
    for (let i = 0; i < MAX_RETURNS; i++) {
      r.clock.t += 1000;
      expect(pulled(r)).toEqual([id]);
    }
    expect(r.store.get(id)).toMatchObject({ state: "delivering", pulled: true });
    r.clock.t += 1000;
    expect(pulled(r)).toEqual([]);
    expect(r.store.get(id)).toMatchObject({ state: "delivered", certainty: "accepted" });
    r.clock.t += 1000;
    expect(pulled(r)).toEqual([]);
  });

  it("does not settle one that is confirmed in time, which stays confirmed", () => {
    const r = make();
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    pulled(r);
    r.clock.t += 1000;
    pulled(r);
    expect(pulled(r, [id])).toEqual([]);
    expect(r.store.get(id)).toMatchObject({ state: "delivered", certainty: "confirmed" });
  });

  it("counts each message on its own", () => {
    const r = make();
    const one = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    pulled(r);
    for (let i = 0; i < MAX_RETURNS; i++) {
      r.clock.t += 1000;
      pulled(r);
    }
    const two = accepted(r.service.send("alpha", alpha, to("b2"), "two"));
    r.clock.t += 1000;
    expect(pulled(r)).toEqual([two]);
    expect(r.store.get(one)?.state).toBe("delivered");
  });
});

describe("2. the hop rule for send", () => {
  it("tells a send that the session was answering a recent message, not that its thread is full", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxHops: 0 } });
    const first = accepted(r.service.send("alpha", alpha, to(), "ping"));
    for (const h of r.service.nextFor("beta")) r.service.outcome("beta", { id: h.id, attempt: h.attempt, result: { ok: true, certainty: "confirmed" } });
    const refused = r.service.send("beta", beta(), to("a1", "alpha"), "a new topic");
    if (refused.kind !== "refused") throw new Error("expected a refusal");
    expect(refused.reason).toEqual({ kind: "hops", limit: 0, sendWindowMs: HOP_MEMORY_MS });
    const text = senderText(refused.reason);
    expect(text).toContain("answering a recent message from that container");
    expect(text).toContain("10 minutes");
    expect(text).not.toContain("this thread");
    expect(r.store.get(first)?.state).toBe("delivered");
  });

  it("keeps the plain wording for a reply, which does have a thread", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxHops: 0 } });
    const first = accepted(r.service.send("alpha", alpha, to(), "ping"));
    for (const h of r.service.nextFor("beta")) r.service.outcome("beta", { id: h.id, attempt: h.attempt, result: { ok: true, certainty: "confirmed" } });
    const refused = r.service.reply("beta", beta(), first, "pong");
    if (refused.kind !== "refused") throw new Error("expected a refusal");
    expect(senderText(refused.reason)).toBe("this thread already has 0 replies, the most allowed");
  });

  it("stores the window beside the reason, so the audit shows where the count came from", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxHops: 0 } });
    accepted(r.service.send("alpha", alpha, to(), "ping"));
    for (const h of r.service.nextFor("beta")) r.service.outcome("beta", { id: h.id, attempt: h.attempt, result: { ok: true, certainty: "confirmed" } });
    const refused = r.service.send("beta", beta(), to("a1", "alpha"), "a new topic");
    expect(r.store.get(refused.kind === "refused" ? refused.id : "")?.reason).toEqual({ kind: "hops", limit: 0, sendWindowMs: HOP_MEMORY_MS });
  });
});

describe("5. inbox returns a bounded number of messages", () => {
  it("hands out at most the bound in one call and the rest in the next, oldest first", () => {
    const r = make({ ...ALLOW_ALL, limits: { rate: { messages: 1000 } } });
    const ids = Array.from({ length: MAX_INBOX_MESSAGES + 5 }, (_, i) => accepted(r.service.send("alpha", alpha, to("b2"), `m${i}`)));
    const first = pulled(r);
    expect(first).toEqual(ids.slice(0, MAX_INBOX_MESSAGES));
    expect(pulled(r, first)).toEqual(ids.slice(MAX_INBOX_MESSAGES));
  });
});
