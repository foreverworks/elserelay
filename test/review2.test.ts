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

const DENY_ALL = { rules: [{ name: "closed", from: {}, to: {}, decision: "deny" }] };

describe("6. the hop window counts from the first hand-out", () => {
  const WIDE = { ...ALLOW_ALL, limits: { rate: { messages: 1000 } } };
  /** The hop the next `send` from b2 to alpha starts at. */
  const hopOfSend = (r: Rig): number => {
    const sent = r.service.send("beta", beta("b2"), to("a1", "alpha"), "a new topic");
    return r.store.get(accepted(sent))?.message.hop ?? -1;
  };

  it("a re-pull does not extend the window", () => {
    const r = make(WIDE, 400_000);
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    expect(pulled(r)).toEqual([id]);
    r.clock.t += 400_000;
    expect(pulled(r)).toEqual([id]);
    expect(r.store.get(id)).toMatchObject({ updatedAt: r.clock.t });
    // 700 s after the first hand-out, 300 s after the re-pull: inside the window by the last change, outside it by the first hand-out.
    r.clock.t += 300_000;
    expect(hopOfSend(r)).toBe(0);
  });

  it("an acknowledgement or a settle long after the first hand-out does not open a new window", () => {
    const r = make(WIDE);
    const confirmed = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    expect(pulled(r)).toEqual([confirmed]);
    r.clock.t += HOP_MEMORY_MS + 1;
    expect(pulled(r, [confirmed])).toEqual([]);
    expect(r.store.get(confirmed)).toMatchObject({ state: "delivered", certainty: "confirmed" });
    expect(hopOfSend(r)).toBe(0);

    const settled = accepted(r.service.send("alpha", alpha, to("b2"), "two"));
    expect(pulled(r)).toEqual([settled]);
    r.clock.t += HOP_MEMORY_MS + 1;
    for (let i = 0; i < MAX_RETURNS; i++) {
      expect(pulled(r)).toEqual([settled]);
      r.clock.t += 1000;
    }
    expect(pulled(r)).toEqual([]);
    expect(r.store.get(settled)).toMatchObject({ state: "delivered", certainty: "accepted" });
    expect(hopOfSend(r)).toBe(0);
  });

  it("still continues the count inside the window, whatever became of the message since", () => {
    const r = make(WIDE);
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    pulled(r);
    r.clock.t += HOP_MEMORY_MS - 1000;
    pulled(r, [id]);
    expect(hopOfSend(r)).toBe(1);
  });
});

describe("7. settling beside the other limits of inbox", () => {
  const WIDE = { ...ALLOW_ALL, limits: { rate: { messages: 1000 } } };
  const pullsOf = (r: Rig, id: string): number => r.store.pullsOf(id);

  it("settling does not use up the cap: a call that settles 50 messages still hands out the next ones", () => {
    const r = make(WIDE);
    const ids = Array.from({ length: MAX_INBOX_MESSAGES + 10 }, (_, i) => accepted(r.service.send("alpha", alpha, to("b2"), `m${i}`)));
    const older = ids.slice(0, MAX_INBOX_MESSAGES);
    const newer = ids.slice(MAX_INBOX_MESSAGES);
    expect(pulled(r)).toEqual(older);
    expect(pulled(r)).toEqual(newer);
    // Everything is overdue from here on; the 50 oldest come first every time, so the 10 behind them wait.
    for (let i = 0; i < MAX_RETURNS; i++) {
      r.clock.t += 1000;
      expect(pulled(r)).toEqual(older);
    }
    expect(older.map((id) => pullsOf(r, id))).toEqual(older.map(() => MAX_RETURNS + 1));
    expect(newer.map((id) => pullsOf(r, id))).toEqual(newer.map(() => 1));
    r.clock.t += 1000;
    expect(pulled(r)).toEqual(newer);
    expect(older.map((id) => r.store.get(id)?.state)).toEqual(older.map(() => "delivered"));
    expect(older.map((id) => r.store.get(id)?.certainty)).toEqual(older.map(() => "accepted"));
    expect(newer.map((id) => pullsOf(r, id))).toEqual(newer.map(() => 2));
  });

  it("settles more than 50 at once, whatever the cap, and hands out what is behind them", () => {
    const r = make(WIDE);
    const overdue = Array.from({ length: MAX_INBOX_MESSAGES + 10 }, (_, i) => accepted(r.service.send("alpha", alpha, to("b2"), `m${i}`)));
    expect(pulled(r).length).toBe(MAX_INBOX_MESSAGES);
    expect(pulled(r).length).toBe(10);
    const fresh = Array.from({ length: 3 }, (_, i) => accepted(r.service.send("alpha", alpha, to("b2"), `new${i}`)));
    // The first 55 have been returned as often as the rule allows (the extra pulls stand for earlier calls), the last 5 once.
    const atThreshold = overdue.slice(0, MAX_INBOX_MESSAGES + 5);
    const behind = overdue.slice(MAX_INBOX_MESSAGES + 5);
    for (const id of atThreshold) {
      for (let i = 0; i < MAX_RETURNS; i++) r.store.apply(id, { kind: "pull" }, r.clock.t);
    }
    r.clock.t += 1000;
    expect(pulled(r)).toEqual([...behind, ...fresh]);
    expect(atThreshold.map((id) => r.store.get(id))).toEqual(atThreshold.map(() => expect.objectContaining({ state: "delivered", certainty: "accepted" })));
    expect(behind.map((id) => pullsOf(r, id))).toEqual(behind.map(() => 2));
  });

  it("settles nothing while the gateway is stopped, and a confirmation still counts", () => {
    const r = make();
    const settled = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    const confirmed = accepted(r.service.send("alpha", alpha, to("b2"), "two"));
    pulled(r);
    for (let i = 0; i < MAX_RETURNS; i++) r.store.apply(settled, { kind: "pull" }, r.clock.t);
    r.clock.t += 1000;
    r.store.setStopped(true, r.clock.t);
    const entries = r.store.audit(0).length;
    // Stopped, `inbox` hands out and settles nothing; it does take the session's confirmation, which is the session's word, not a delivery.
    expect(pulled(r, [confirmed])).toEqual([]);
    expect(r.store.get(confirmed)).toMatchObject({ state: "delivered", certainty: "confirmed" });
    expect(r.store.get(settled)).toMatchObject({ state: "delivering", pulled: true });
    expect(r.store.audit(0).length).toBe(entries + 1);
    r.store.setStopped(false, r.clock.t);
    expect(pulled(r)).toEqual([]);
    expect(r.store.get(settled)).toMatchObject({ state: "delivered", certainty: "accepted" });
  });

  it("refuses a message at the threshold whose policy has become deny, instead of settling it as delivered", () => {
    const r = make();
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "secret words"));
    pulled(r);
    for (let i = 0; i < MAX_RETURNS; i++) r.store.apply(id, { kind: "pull" }, r.clock.t);
    r.clock.t += 1000;
    expect(r.withPolicy(policyOf(DENY_ALL)).inbox("beta", "b2")).toEqual({ kind: "ok", messages: [] });
    expect(r.store.get(id)).toMatchObject({ state: "refused", reason: { kind: "policy", rule: "closed" }, certainty: null });
    expect(r.store.get(id)?.message.body).toBe("");
  });
});
