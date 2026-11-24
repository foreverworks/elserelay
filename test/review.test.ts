/** The fixes from the independent review of the broker (foreverworks/elserelay#5), one group each. */
import { afterEach, describe, expect, it } from "vitest";
import { makeService } from "../src/broker/service.js";
import type { Service } from "../src/broker/service.js";
import type { Store } from "../src/store/types.js";
import type { Rig } from "./broker-fixtures.js";
import { ALLOW_ALL, PRODUCTS_OF, policyOf, report, rig, seen } from "./broker-fixtures.js";

let current: Rig | undefined;
const make = (policy: unknown = ALLOW_ALL, deliveryTimeoutMs?: number): Rig => {
  current = rig(policyOf(policy), deliveryTimeoutMs);
  const { service } = current;
  service.report("beta", report("codex", [seen("b1", "idle", "Beta one"), seen("b2", "cold"), seen("b3", "busy")]));
  service.report("alpha", report("claude", [seen("a1", "idle", "Alpha one")]));
  return current;
};
afterEach(() => current?.store.close());

const alpha = { session: "a1", title: "Alpha one" };
const beta = (session = "b1") => ({ session, title: null });
const to = (session = "b1", container = "beta") => ({ container, session });
const ok = { ok: true, certainty: "confirmed" } as const;

const accepted = (r: ReturnType<Service["send"]>): string => {
  if (r.kind !== "accepted") throw new Error(`not accepted: ${JSON.stringify(r)}`);
  return r.id;
};

/** Pushes the container's waiting messages and reports each delivered. */
function deliverAll(r: Rig, container: string): void {
  for (const h of r.service.nextFor(container)) r.service.outcome(container, { id: h.id, attempt: h.attempt, result: ok });
}

describe("1. hops count through send", () => {
  it("starts a send one hop after the newest message its session was handed by the target, in a new thread", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxHops: 2 } });
    const first = accepted(r.service.send("alpha", alpha, to(), "ping"));
    deliverAll(r, "beta");
    const second = accepted(r.service.send("beta", beta(), to("a1", "alpha"), "pong"));
    expect(r.store.get(second)?.message).toMatchObject({ hop: 1, replyTo: null, thread: second });
    expect(r.store.get(first)?.message.hop).toBe(0);
    deliverAll(r, "alpha");
    const third = accepted(r.service.send("alpha", alpha, to(), "ping again"));
    expect(r.store.get(third)?.message.hop).toBe(2);
    deliverAll(r, "beta");
    // Two agents that keep sending to each other, never replying, reach the limit like a chain of replies.
    expect(r.service.send("beta", beta(), to("a1", "alpha"), "pong again")).toMatchObject({ kind: "refused", reason: { kind: "hops", limit: 2 } });
  });

  it("counts a message that was pulled and not yet confirmed, because the session has seen it", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxHops: 1 } });
    accepted(r.service.send("alpha", alpha, to("b2"), "ping"));
    r.service.inbox("beta", "b2");
    const back = accepted(r.service.send("beta", beta("b2"), to("a1", "alpha"), "pong"));
    expect(r.store.get(back)?.message.hop).toBe(1);
  });

  it("forgets after ten minutes, and ignores other sessions, other containers and messages that never reached the session", () => {
    const r = make();
    accepted(r.service.send("alpha", alpha, to(), "ping"));
    deliverAll(r, "beta");
    expect(r.store.get(accepted(r.service.send("beta", beta("b3"), to("a1", "alpha"), "other session")))?.message.hop).toBe(0);
    expect(r.store.get(accepted(r.service.send("beta", beta(), to("a1", "alpha"), "same session")))?.message.hop).toBe(1);
    r.clock.t += 600_000;
    expect(r.store.get(accepted(r.service.send("beta", beta(), to("a1", "alpha"), "ten minutes later")))?.message.hop).toBe(1);
    r.clock.t += 1;
    expect(r.store.get(accepted(r.service.send("beta", beta(), to("a1", "alpha"), "past the window")))?.message.hop).toBe(0);
    // Handed to alpha by beta, not by gamma.
    deliverAll(r, "alpha");
    r.service.report("gamma", report("fake", [seen("g1")]));
    expect(r.store.get(accepted(r.service.send("alpha", alpha, to("g1", "gamma"), "to gamma")))?.message.hop).toBe(0);
  });

  it("does not change a reply, which still follows its own thread", () => {
    const r = make();
    const first = accepted(r.service.send("alpha", alpha, to(), "ping"));
    deliverAll(r, "beta");
    const answer = r.service.reply("beta", beta(), first, "pong");
    expect(answer.kind === "accepted" && r.store.get(answer.id)?.message).toMatchObject({ hop: 1, thread: first, replyTo: first });
  });
});

describe("2. a refused message keeps no body, and refusals are limited", () => {
  const SECRET = "the whole text of a refused message";

  it("stores no text for a message refused at once, only its length and hash", () => {
    const r = make({ rules: [] });
    const sent = r.service.send("alpha", alpha, to(), SECRET);
    expect(sent.kind).toBe("refused");
    const stored = r.store.get("id1");
    expect(stored?.message).toMatchObject({ body: "", bodyChars: SECRET.length });
    expect(stored?.message.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not even hand the text to the store for a message refused at once", () => {
    const r = make({ rules: [] });
    const received: string[] = [];
    const service = makeService({
      store: { ...r.store, receive: (m, at) => (received.push(m.body), r.store.receive(m, at)) },
      policy: policyOf({ rules: [] }),
      products: PRODUCTS_OF,
      now: () => r.clock.t,
      newId: () => "z1",
      deliveryTimeoutMs: 1000,
    });
    expect(service.send("alpha", alpha, to(), SECRET).kind).toBe("refused");
    expect(received).toEqual([""]);
  });

  it("stores no text for a body over the limit, and keeps the length of what was sent", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxBodyChars: 10 } });
    r.service.send("alpha", alpha, to(), "x".repeat(5000));
    expect(r.store.get("id1")?.message).toMatchObject({ body: "", bodyChars: 5000 });
  });

  it("drops the text when a message is refused later, by a person or by the policy", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }] });
    const id = accepted(r.service.send("alpha", alpha, to(), SECRET));
    expect(r.service.approvals()[0]?.body).toBe(SECRET);
    expect(r.store.get(id)?.message.body).toBe(SECRET);
    r.service.refuse(id);
    expect(r.store.get(id)?.message).toMatchObject({ body: "", bodyChars: SECRET.length });

    const open = make();
    const queued = accepted(open.service.send("alpha", alpha, to(), SECRET));
    open.withPolicy(policyOf({ rules: [] })).nextFor("beta");
    expect(open.store.get(queued)).toMatchObject({ state: "refused", message: { body: "" } });
  });

  it("keeps the text of a message that went through", () => {
    const r = make();
    expect(r.store.get(accepted(r.service.send("alpha", alpha, to(), SECRET)))?.message.body).toBe(SECRET);
  });

  describe("the budget of refusals per sender container", () => {
    const limited = (): Rig => make({ rules: [], limits: { refusals: { messages: 2, windowMs: 1000 } } });
    const refuse = (r: Rig) => r.service.send("alpha", alpha, to(), "no");

    it("stores nothing past it, tells the sender, and writes one line per window", () => {
      const r = limited();
      expect(refuse(r)).toMatchObject({ kind: "refused", reason: { kind: "policy" } });
      expect(refuse(r)).toMatchObject({ kind: "refused", reason: { kind: "policy" } });
      const over = refuse(r);
      expect(over).toMatchObject({ kind: "refused", reason: { kind: "refusals", limit: 2, windowMs: 1000 } });
      expect(refuse(r)).toMatchObject({ reason: { kind: "refusals" } });
      expect(r.store.get("id3")).toBeNull();
      expect(r.store.get("id4")).toBeNull();
      expect(r.store.audit(0).filter((e) => e.event === "receive")).toHaveLength(2);
      expect(r.store.controlAudit(0)).toEqual([{ at: 10_000, action: "refusals-limited", container: "alpha", limit: 2, windowMs: 1000 }]);
    });

    it("counts per container, and records refusals again once the window has passed, with a new line when it is over again", () => {
      const r = limited();
      refuse(r);
      refuse(r);
      expect(refuse(r)).toMatchObject({ reason: { kind: "refusals" } });
      expect(r.service.send("beta", beta(), to("a1", "alpha"), "other sender")).toMatchObject({ kind: "refused", reason: { kind: "policy" } });
      r.clock.t += 1001;
      expect(refuse(r)).toMatchObject({ reason: { kind: "policy" } });
      refuse(r);
      expect(refuse(r)).toMatchObject({ reason: { kind: "refusals" } });
      expect(r.store.controlAudit(0).map((e) => e.action)).toEqual(["refusals-limited", "refusals-limited"]);
    });

    it("does not stop a message that would be accepted", () => {
      const r = make({ rules: [{ name: "ask", from: { container: "alpha" }, to: { container: "beta" }, decision: "allow" }], limits: { refusals: { messages: 1, windowMs: 1000 } } });
      r.service.send("alpha", alpha, to("nope"), "refused once");
      expect(r.service.send("alpha", alpha, to("nope"), "refused again")).toMatchObject({ reason: { kind: "refusals" } });
      expect(r.service.send("alpha", alpha, to(), "fine")).toMatchObject({ kind: "accepted" });
    });
  });
});

describe("3. a message whose push has no outcome is not pulled", () => {
  const lose = (r: Rig, id: string): void => {
    r.clock.t += 1001;
    r.service.tick();
    expect(r.store.get(id)).toMatchObject({ state: "queued", reason: { kind: "no-outcome" } });
  };

  it("leaves it to the push path, which retries it with the same id", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b1"), "hi"));
    r.service.nextFor("beta");
    lose(r, id);
    expect(r.service.inbox("beta", "b1")).toEqual({ kind: "ok", messages: [] });
    expect(r.store.get(id)?.state).toBe("queued");
    expect(r.service.nextFor("beta").map((h) => [h.id, h.attempt])).toEqual([[id, 2]]);
  });

  it("still hands it out to the session once a later attempt ended with a definite failure", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b1"), "hi"));
    r.service.nextFor("beta");
    lose(r, id);
    r.service.nextFor("beta");
    r.service.outcome("beta", { id, attempt: 2, result: { ok: false, retry: true, detail: "busy" } });
    const got = r.service.inbox("beta", "b1");
    expect(got.kind === "ok" && got.messages.map((m) => m.id)).toEqual([id]);
  });

  it("may be pulled when its push failed with a definite outcome", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b1"), "hi"));
    r.service.nextFor("beta");
    r.service.outcome("beta", { id, attempt: 1, result: { ok: false, retry: true, detail: "busy" } });
    const got = r.service.inbox("beta", "b1");
    expect(got.kind === "ok" && got.messages.map((m) => m.id)).toEqual([id]);
  });

  it("is refused when the attempts run out without an outcome, saying so", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxAttempts: 1 } }, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b1"), "hi"));
    r.service.nextFor("beta");
    r.clock.t += 1001;
    r.service.tick();
    expect(r.store.get(id)).toMatchObject({ state: "refused", reason: { kind: "no-outcome", ms: 1000 } });
  });
});

describe("4. inbox hands out, then the session confirms", () => {
  const pulledIds = (r: Rig, session = "b2", received?: readonly string[]): string[] => {
    const got = r.service.inbox("beta", session, received);
    return got.kind === "ok" ? got.messages.map((m) => m.id) : [];
  };

  it("returns what was not confirmed after the delivery timeout, marked as seen before, and not before", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    const first = r.service.inbox("beta", "b2");
    expect(first.kind === "ok" && first.messages[0]?.text.startsWith("This is a message")).toBe(true);
    r.clock.t += 999;
    expect(pulledIds(r)).toEqual([]);
    r.clock.t += 1;
    const again = r.service.inbox("beta", "b2");
    expect(again.kind === "ok" && again.messages.map((m) => m.id)).toEqual([id]);
    const text = again.kind === "ok" ? (again.messages[0]?.text ?? "") : "";
    const [line, ...rest] = text.split("\n");
    expect(line).toContain("given to you before");
    expect(rest.join("\n")).toContain("This is a message from another agent session");
    expect(r.store.get(id)).toMatchObject({ state: "delivering", pulled: true, attempts: 0 });
  });

  it("stops returning it once its id is passed in received", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    pulledIds(r);
    r.clock.t += 5000;
    expect(pulledIds(r, "b2", [id])).toEqual([]);
    expect(r.store.get(id)).toMatchObject({ state: "delivered", certainty: "confirmed" });
    r.clock.t += 5000;
    expect(pulledIds(r)).toEqual([]);
  });

  it("confirms and hands out in one call", () => {
    const r = make(ALLOW_ALL, 1000);
    const one = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    pulledIds(r);
    const two = accepted(r.service.send("alpha", alpha, to("b2"), "two"));
    expect(pulledIds(r, "b2", [one])).toEqual([two]);
    expect(r.store.get(one)?.state).toBe("delivered");
  });

  it("is not counted as an attempt, so repeated returns never refuse it; only the expiry ends it", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxAttempts: 1, messageTtlMs: 100_000 } }, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    // The first pull and the three returns that are allowed.
    for (let i = 0; i < 4; i++) {
      expect(pulledIds(r)).toEqual([id]);
      r.clock.t += 1000;
      r.service.tick();
    }
    expect(r.store.get(id)).toMatchObject({ state: "delivering", attempts: 0 });
    r.clock.t += 100_000;
    r.service.tick();
    expect(r.store.get(id)?.state).toBe("expired");
    expect(pulledIds(r)).toEqual([]);
  });

  it("is not sent back to the queue by the delivery timeout of the push path", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    pulledIds(r);
    r.clock.t += 60_000;
    r.service.tick();
    expect(r.store.get(id)).toMatchObject({ state: "delivering", pulled: true });
  });

  it("does not block the push path for the same session", () => {
    const r = make(ALLOW_ALL, 1000);
    accepted(r.service.send("alpha", alpha, to("b1"), "one"));
    pulledIds(r, "b1");
    const two = accepted(r.service.send("alpha", alpha, to("b1"), "two"));
    expect(r.service.nextFor("beta").map((h) => h.id)).toEqual([two]);
  });

  it("is delivered by an answer to the message, whatever happened to the confirmation", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    pulledIds(r);
    expect(r.service.reply("beta", beta("b2"), id, "answer")).toMatchObject({ kind: "accepted" });
    expect(r.store.get(id)).toMatchObject({ state: "delivered", certainty: "confirmed" });
  });

  it("is confirmed by its own addressee only", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    pulledIds(r);
    expect(r.service.inbox("beta", "b1", [id])).toEqual({ kind: "ok", messages: [] });
    expect(r.service.inbox("alpha", "b2", [id])).toEqual({ kind: "ok", messages: [] });
    expect(r.service.acknowledge("gamma", "b2", [id])).toEqual({ kind: "ok" });
    expect(r.service.acknowledge("ghost", "b2", [id])).toEqual({ kind: "forbidden" });
    expect(r.store.get(id)?.state).toBe("delivering");
    expect(r.service.acknowledge("beta", "b2", [id, "nope"])).toEqual({ kind: "ok" });
    expect(r.store.get(id)?.state).toBe("delivered");
  });

  it("confirms nothing that is not out with the session, and hands out nothing while only acknowledging", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    expect(r.service.acknowledge("beta", "b2", [id])).toEqual({ kind: "ok" });
    expect(r.store.get(id)?.state).toBe("queued");
  });

  it("applies the policy again to a message it returns", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b2"), "one"));
    pulledIds(r);
    r.clock.t += 1000;
    const stricter = r.withPolicy(policyOf({ rules: [] }));
    expect(stricter.inbox("beta", "b2")).toEqual({ kind: "ok", messages: [] });
    expect(r.store.get(id)).toMatchObject({ state: "refused", reason: { kind: "policy" } });
  });
});

describe("5. the clock's writes lose to a newer answer", () => {
  /** A service whose reads of one kind return what they saw before `between` ran, as if another process had answered in between. */
  function racing(r: Rig, between: () => void, read: "held" | "expired" | "overdue"): Service {
    const store: Store = {
      ...r.store,
      [read]: (...args: never[]) => {
        const stale = (r.store[read] as (...a: never[]) => readonly unknown[])(...args);
        between();
        return stale;
      },
    } as Store;
    return makeService({
      store,
      policy: policyOf({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }], limits: { approvalTtlMs: 1000 } }),
      products: PRODUCTS_OF,
      now: () => r.clock.t,
      newId: () => "x",
      deliveryTimeoutMs: 1000,
    });
  }

  it("does not refuse a message a person approved between the read and the write", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }], limits: { approvalTtlMs: 1000 } });
    const id = accepted(r.service.send("alpha", alpha, to("b1"), "hi"));
    r.clock.t += 1000;
    const service = racing(r, () => void r.store.apply(id, { kind: "approve" }, r.clock.t), "held");
    service.tick();
    expect(r.store.get(id)?.state).toBe("queued");
    expect(r.store.audit(0).filter((e) => e.message === id).map((e) => e.event)).toEqual(["receive", "hold", "approve"]);
  });

  it("does not expire a message that was answered between the read and the write", () => {
    const r = make({ ...ALLOW_ALL, limits: { messageTtlMs: 1000 } });
    const id = accepted(r.service.send("alpha", alpha, to("b1"), "hi"));
    r.clock.t += 1000;
    const service = racing(r, () => void r.store.apply(id, { kind: "refuse", reason: { kind: "approver", answer: "no" } }, r.clock.t), "expired");
    service.tick();
    expect(r.store.get(id)).toMatchObject({ state: "refused", reason: { kind: "approver", answer: "no" } });
  });

  it("does not retry a delivery whose outcome arrived between the read and the write", () => {
    const r = make(ALLOW_ALL, 1000);
    const id = accepted(r.service.send("alpha", alpha, to("b1"), "hi"));
    r.service.nextFor("beta");
    r.clock.t += 1001;
    const service = racing(r, () => void r.service.outcome("beta", { id, attempt: 1, result: ok }), "overdue");
    service.tick();
    expect(r.store.get(id)?.state).toBe("delivered");
  });

  it("refuses an approval that comes at or after the deadline, with the reason timeout", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }], limits: { approvalTtlMs: 1000 } });
    const late = accepted(r.service.send("alpha", alpha, to("b1"), "late"));
    const early = accepted(r.service.send("alpha", alpha, to("b1"), "early"));
    r.clock.t += 999;
    expect(r.service.approve(early)).toEqual({ ok: true });
    r.clock.t += 1;
    expect(r.service.approve(late)).toEqual({ ok: false, why: "timed-out" });
    expect(r.store.get(late)).toMatchObject({ state: "refused", reason: { kind: "approver", answer: "timeout" } });
    expect(r.store.get(early)?.state).toBe("queued");
  });

  it("lets a person's no stand at the deadline", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }], limits: { approvalTtlMs: 1000 } });
    const id = accepted(r.service.send("alpha", alpha, to("b1"), "x"));
    r.clock.t += 1000;
    expect(r.service.refuse(id)).toEqual({ ok: true });
    expect(r.store.get(id)?.reason).toEqual({ kind: "approver", answer: "no" });
  });
});

describe("6. what is reported is cleaned", () => {
  it("cleans titles, and leaves out a session id that cleaning would change", () => {
    const r = make();
    r.service.report(
      "beta",
      report("codex", [
        seen("fine", "idle", "a‮evil\u0007 title\nsecond line"),
        seen("two\nlines"),
        seen(" padded"),
        seen("bidi‮"),
        seen("x".repeat(81)),
        seen("empty-title", "idle", "\u0007"),
      ]),
    );
    const peers = r.service.listPeers("alpha");
    const beta = Array.isArray(peers) ? peers.filter((p) => p.container === "beta") : [];
    expect(beta.map((p) => [p.session, p.title])).toEqual([["empty-title", null], ["fine", "aevil title second line"]]);
    expect(r.store.peers().filter((p) => p.container === "beta").map((p) => p.session)).toEqual(["empty-title", "fine"]);
  });

  it("cleans the claim of a sender before it reaches the audit and the approver", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }] });
    const sent = r.service.send("alpha", { session: "a1‮\nforged: yes", title: "Boss\r\nApproved" }, to(), "x");
    const id = accepted(sent);
    expect(r.store.get(id)?.message.from).toMatchObject({ session: "a1 forged: yes", title: "Boss Approved" });
    expect(r.service.approvals()[0]?.from.session).toBe("a1 forged: yes");
    expect(r.store.audit(0).every((e) => e.from.session === "a1 forged: yes")).toBe(true);
  });
});

describe("7. an unknown container and a policy refusal are answered alike", () => {
  it("returns the same answer in the same shape, but for the ids", () => {
    const r = make({ rules: [{ name: "no-codex", from: {}, to: { product: "codex" }, decision: "deny" }] });
    const denied = r.service.send("alpha", alpha, to("b1", "beta"), "x");
    const unknown = r.service.send("alpha", alpha, to("b1", "nowhere"), "x");
    expect(denied.kind).toBe("refused");
    const strip = (s: typeof denied) => (s.kind === "refused" ? { ...s, id: "", thread: "", reason: s.reason.kind === "policy" ? { kind: "policy" } : s.reason } : s);
    expect(strip(unknown)).toEqual(strip(denied));
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(denied).sort());
  });

  it("is the same answer even when no rule matches, with a null rule in both", () => {
    const r = make({ rules: [] });
    const denied = r.service.send("alpha", alpha, to("b1", "beta"), "x");
    const unknown = r.service.send("alpha", alpha, to("b1", "nowhere"), "x");
    expect(denied).toMatchObject({ kind: "refused", reason: { kind: "policy", rule: null } });
    expect(unknown).toMatchObject({ kind: "refused", reason: { kind: "policy", rule: null } });
  });

  it("keeps the true reason for the operator, in the audit", () => {
    const r = make();
    r.service.send("alpha", alpha, to("b1", "nowhere"), "x");
    expect(r.store.audit(0)[1]).toMatchObject({ event: "refuse", detail: { kind: "unknown-peer" } });
  });
});
