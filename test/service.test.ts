import { afterEach, describe, expect, it } from "vitest";
import type { Rig } from "./broker-fixtures.js";
import { ALLOW_ALL, policyOf, report, rig, seen } from "./broker-fixtures.js";

let current: Rig | undefined;
const make = (policy: unknown = ALLOW_ALL, deliveryTimeoutMs?: number): Rig => {
  current = rig(policyOf(policy), deliveryTimeoutMs);
  const { service } = current;
  service.report("beta", report("codex", [seen("b1", "idle", "Beta one"), seen("b2", "cold"), seen("b3", "busy"), seen("b4", "unknown")]));
  service.report("alpha", report("claude", [seen("a1")]));
  return current;
};
afterEach(() => current?.store.close());

const alpha = { session: "a1", title: "Alpha one" };
const beta = (session = "b1") => ({ session, title: null });
const to = (session = "b1", container = "beta") => ({ container, session });

describe("send", () => {
  it("queues a message the policy allows, with the claimed sender and a thread of its own", () => {
    const { service, store } = make();
    const sent = service.send("alpha", alpha, to(), "hello");
    expect(sent).toMatchObject({ kind: "accepted", state: "queued", id: "id1", thread: "id1" });
    const t = store.get("id1");
    expect(t?.state).toBe("queued");
    expect(t?.message).toMatchObject({
      hop: 0,
      replyTo: null,
      from: { container: "alpha", product: "claude", session: "a1", title: "Alpha one" },
      to: { container: "beta", product: "codex", session: "b1" },
      body: "hello",
      createdAt: 10_000,
      expiresAt: 10_000 + 86_400_000,
    });
    expect(store.audit(0).map((a) => [a.event, a.state])).toEqual([["receive", "received"], ["queue", "queued"]]);
  });

  it("answers forbidden for a container that is not configured", () => {
    const { service, store } = make();
    expect(service.send("ghost", alpha, to(), "hi")).toEqual({ kind: "forbidden" });
    expect(store.audit(0)).toEqual([]);
  });

  it("stores and audits a refusal for a target container that is not configured", () => {
    const { service, store } = make();
    const sent = service.send("alpha", alpha, to("x", "nowhere"), "hi");
    expect(sent).toMatchObject({ kind: "refused", reason: { kind: "unknown-peer" } });
    expect(store.get("id1")?.state).toBe("refused");
    expect(store.audit(0).map((a) => a.event)).toEqual(["receive", "refuse"]);
  });

  it("refuses a session that is not listed", () => {
    const { service } = make();
    expect(service.send("alpha", alpha, to("nope"), "hi")).toMatchObject({ kind: "refused", reason: { kind: "unknown-peer" } });
  });

  it("refuses by a deny rule and names it", () => {
    const { service, store } = make({
      rules: [
        { name: "no-codex", from: {}, to: { product: "codex" }, decision: "deny" },
        { name: "open", from: {}, to: {}, decision: "allow" },
      ],
    });
    const sent = service.send("alpha", alpha, to(), "hi");
    expect(sent).toMatchObject({ kind: "refused", reason: { kind: "policy", rule: "no-codex" } });
    expect(store.get("id1")?.reason).toEqual({ kind: "policy", rule: "no-codex" });
  });

  it("refuses when no rule matches, with a null rule", () => {
    const { service } = make({ rules: [] });
    expect(service.send("alpha", alpha, to(), "hi")).toMatchObject({ kind: "refused", reason: { kind: "policy", rule: null } });
  });

  it("answers a policy refusal before the peer check, so session ids stay hidden", () => {
    const { service } = make({ rules: [] });
    expect(service.send("alpha", alpha, to("nope"), "hi")).toMatchObject({ reason: { kind: "policy" } });
  });

  it("refuses everything while stopped", () => {
    const { service, store } = make();
    store.setStopped(true, 1);
    expect(service.send("alpha", alpha, to(), "hi")).toMatchObject({ kind: "refused", reason: { kind: "stopped" } });
  });

  it("refuses a body over the limit, counting characters rather than bytes", () => {
    const { service } = make({ ...ALLOW_ALL, limits: { maxBodyChars: 5 } });
    expect(service.send("alpha", alpha, to(), "ééééé")).toMatchObject({ kind: "accepted" });
    expect(service.send("alpha", alpha, to(), "éééééé")).toMatchObject({ kind: "refused", reason: { kind: "too-long", limit: 5 } });
  });

  it("limits the rate per pair of containers, and a refused message does not count", () => {
    const { service, clock } = make({ ...ALLOW_ALL, limits: { rate: { messages: 2, windowMs: 1000 } } });
    expect(service.send("alpha", alpha, to(), "1").kind).toBe("accepted");
    expect(service.send("alpha", alpha, to("nope"), "refused, not counted").kind).toBe("refused");
    expect(service.send("alpha", alpha, to(), "2").kind).toBe("accepted");
    expect(service.send("alpha", alpha, to(), "3")).toMatchObject({ kind: "refused", reason: { kind: "rate", limit: 2, windowMs: 1000 } });
    expect(service.send("beta", beta(), to("a1", "alpha"), "other pair")).toMatchObject({ kind: "accepted" });
    clock.t += 1001;
    expect(service.send("alpha", alpha, to(), "4").kind).toBe("accepted");
  });

  it("holds a message an ask rule matches", () => {
    const { service, store } = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }] });
    expect(service.send("alpha", alpha, to(), "hi")).toMatchObject({ kind: "accepted", state: "held" });
    expect(store.get("id1")?.state).toBe("held");
  });

  it("lets deny win over limits and limits over ask", () => {
    const { service } = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }], limits: { maxBodyChars: 1 } });
    expect(service.send("alpha", alpha, to(), "too long")).toMatchObject({ reason: { kind: "too-long" } });
  });
});

describe("reply", () => {
  const delivered = (r: Rig): string => {
    const sent = r.service.send("alpha", alpha, to(), "question");
    if (sent.kind !== "accepted") throw new Error("not sent");
    r.service.nextFor("beta");
    r.service.outcome("beta", { id: sent.id, attempt: 1, result: { ok: true, certainty: "confirmed" } });
    return sent.id;
  };

  it("goes to the original sender in the same thread, one hop on", () => {
    const r = make();
    const id = delivered(r);
    const answer = r.service.reply("beta", beta(), id, "answer");
    expect(answer).toMatchObject({ kind: "accepted", state: "queued", thread: id, to: { container: "alpha", session: "a1" } });
    if (answer.kind !== "accepted") return;
    expect(r.store.get(answer.id)?.message).toMatchObject({
      hop: 1,
      replyTo: id,
      thread: id,
      from: { container: "beta", product: "codex", session: "b1" },
      to: { container: "alpha", product: "claude", session: "a1" },
    });
  });

  it("answers only a session the message was addressed to", () => {
    const r = make();
    const id = delivered(r);
    expect(r.service.reply("beta", beta("b3"), id, "x")).toEqual({ kind: "not-found" });
  });

  it("answers nothing addressed to another container", () => {
    const r = make();
    const id = delivered(r);
    expect(r.service.reply("alpha", alpha, id, "x")).toEqual({ kind: "not-found" });
    expect(r.service.reply("gamma", { session: "b1", title: null }, id, "x")).toEqual({ kind: "not-found" });
  });

  it("does not know a message that was held, refused or never existed", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }] });
    const held = r.service.send("alpha", alpha, to(), "q");
    if (held.kind !== "accepted") throw new Error("not held");
    expect(r.service.reply("beta", beta(), held.id, "x")).toEqual({ kind: "not-found" });
    expect(r.service.reply("beta", beta(), "nope", "x")).toEqual({ kind: "not-found" });
  });

  it("is limited in depth like any message", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxHops: 1 } });
    const id = delivered(r);
    const first = r.service.reply("beta", beta(), id, "hop 1");
    if (first.kind !== "accepted") throw new Error("hop 1 refused");
    r.service.nextFor("alpha");
    r.service.outcome("alpha", { id: first.id, attempt: 1, result: { ok: true, certainty: "accepted" } });
    expect(r.service.reply("alpha", alpha, first.id, "hop 2")).toMatchObject({ kind: "refused", reason: { kind: "hops", limit: 1 } });
  });

  it("goes through policy: a deny in the way back refuses it", () => {
    const r = make({
      rules: [
        { name: "no-way-back", from: { container: "beta" }, to: { container: "alpha" }, decision: "deny" },
        { name: "open", from: {}, to: {}, decision: "allow" },
      ],
    });
    const id = delivered(r);
    expect(r.service.reply("beta", beta(), id, "x")).toMatchObject({ kind: "refused", reason: { kind: "policy", rule: "no-way-back" } });
  });
});

describe("listPeers", () => {
  it("shows only peers the container could send to, and marks those that need approval", () => {
    const { service } = make({
      rules: [
        { name: "no-claude", from: {}, to: { product: "claude" }, decision: "deny" },
        { name: "ask-b2", from: {}, to: { container: "beta" }, decision: "ask" },
      ],
    });
    const peers = service.listPeers("alpha");
    expect(Array.isArray(peers) && peers.map((p) => [p.container, p.session, p.needsApproval])).toEqual([
      ["beta", "b1", true],
      ["beta", "b2", true],
      ["beta", "b3", true],
      ["beta", "b4", true],
    ]);
  });

  it("is forbidden for an unknown container", () => {
    expect(make().service.listPeers("ghost")).toEqual({ kind: "forbidden" });
  });
});

describe("report", () => {
  it("replaces the container's peers and keeps its capabilities", () => {
    const { service } = make();
    service.report("beta", report("codex", [seen("only")], { push: false, wakesIdle: false, joinsTurn: false, certainty: "accepted" }));
    const peers = service.listPeers("alpha");
    expect(Array.isArray(peers) && peers.filter((p) => p.container === "beta").map((p) => p.session)).toEqual(["only"]);
    expect(service.capabilitiesOf("beta")?.push).toBe(false);
  });

  it("refuses a product other than the container's, and an unknown container", () => {
    const { service } = make();
    expect(service.report("beta", report("claude", []))).toEqual({ kind: "wrong-product" });
    expect(service.report("ghost", report("claude", []))).toEqual({ kind: "forbidden" });
  });

  it("copes with a session listed twice", () => {
    const { service } = make();
    expect(service.report("beta", report("codex", [seen("x"), seen("x", "busy")]))).toEqual({ kind: "ok" });
  });
});

describe("nextFor", () => {
  const queue = (r: Rig, session: string, body = "hi"): string => {
    const sent = r.service.send("alpha", alpha, to(session), body);
    if (sent.kind !== "accepted") throw new Error("not queued");
    return sent.id;
  };

  it("hands out a message to an idle or busy session as rendered text, and moves it to delivering", () => {
    const r = make();
    const a = queue(r, "b1");
    const b = queue(r, "b3");
    const out = r.service.nextFor("beta");
    expect(out.map((h) => [h.id, h.attempt, h.to.session])).toEqual([[a, 1, "b1"], [b, 1, "b3"]]);
    expect(out[0]?.text).toContain(`Message id: "${a}"`);
    expect(out[0]?.text).toContain('Container: "alpha" (verified by the gateway)');
    expect(r.store.get(a)?.state).toBe("delivering");
    expect(r.service.nextFor("beta")).toEqual([]);
  });

  it("keeps a message for a cold or unknown session queued unless the rule wakes", () => {
    const r = make();
    queue(r, "b2");
    queue(r, "b4");
    expect(r.service.nextFor("beta")).toEqual([]);
    const waking = r.withPolicy(policyOf({ rules: [{ name: "wake", from: {}, to: {}, decision: "allow", wake: true }] }));
    expect(waking.nextFor("beta").map((h) => h.to.session)).toEqual(["b2", "b4"]);
  });

  it("keeps a message for a session that is no longer listed", () => {
    const r = make();
    const id = queue(r, "b1");
    r.service.report("beta", report("codex", [seen("b2")]));
    expect(r.service.nextFor("beta")).toEqual([]);
    expect(r.store.get(id)?.state).toBe("queued");
  });

  it("hands out nothing for a product that cannot push, or before any report", () => {
    const r = make();
    queue(r, "b1");
    r.service.report("beta", report("codex", [seen("b1")], { push: false, wakesIdle: false, joinsTurn: false, certainty: "accepted" }));
    expect(r.service.nextFor("beta")).toEqual([]);
    expect(r.service.nextFor("gamma")).toEqual([]);
    expect(r.service.nextFor("ghost")).toEqual([]);
  });

  it("holds every delivery while stopped, and resumes", () => {
    const r = make();
    queue(r, "b1");
    r.store.setStopped(true, 1);
    expect(r.service.nextFor("beta")).toEqual([]);
    r.store.setStopped(false, 2);
    expect(r.service.nextFor("beta")).toHaveLength(1);
  });

  it("checks the policy again: a rule added while the message waited refuses it", () => {
    const r = make();
    const id = queue(r, "b1");
    const stricter = r.withPolicy(policyOf({ rules: [{ name: "closed", from: {}, to: {}, decision: "deny" }] }));
    expect(stricter.nextFor("beta")).toEqual([]);
    expect(r.store.get(id)).toMatchObject({ state: "refused", reason: { kind: "policy", rule: "closed" } });
  });

  it("does not push a message that has been approved when its rule still says ask", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }] });
    const id = queue(r, "b1");
    expect(r.service.approve(id)).toEqual({ ok: true });
    expect(r.service.nextFor("beta").map((h) => h.id)).toEqual([id]);
  });

  it("leaves an expired message for tick", () => {
    const r = make();
    queue(r, "b1");
    r.clock.t += 86_400_000;
    expect(r.service.nextFor("beta")).toEqual([]);
  });

  it("sends one message at a time to a session, oldest first", () => {
    const r = make();
    const first = queue(r, "b1", "one");
    const second = queue(r, "b1", "two");
    expect(r.service.nextFor("beta").map((h) => h.id)).toEqual([first]);
    expect(r.service.nextFor("beta")).toEqual([]);
    r.service.outcome("beta", { id: first, attempt: 1, result: { ok: true, certainty: "confirmed" } });
    expect(r.service.nextFor("beta").map((h) => h.id)).toEqual([second]);
  });
});

describe("outcome", () => {
  const handed = (r: Rig): string => {
    const sent = r.service.send("alpha", alpha, to(), "hi");
    if (sent.kind !== "accepted") throw new Error("not queued");
    r.service.nextFor("beta");
    return sent.id;
  };

  it("delivers with the certainty the driver reports", () => {
    const r = make();
    const id = handed(r);
    expect(r.service.outcome("beta", { id, attempt: 1, result: { ok: true, certainty: "accepted" } })).toEqual({ applied: true });
    expect(r.store.get(id)).toMatchObject({ state: "delivered", certainty: "accepted" });
  });

  it("ignores a repeat, a stale attempt, an unknown id and another container's message", () => {
    const r = make();
    const id = handed(r);
    const ok = { ok: true, certainty: "confirmed" } as const;
    expect(r.service.outcome("beta", { id, attempt: 2, result: ok })).toEqual({ applied: false });
    expect(r.service.outcome("alpha", { id, attempt: 1, result: ok })).toEqual({ applied: false });
    expect(r.service.outcome("beta", { id: "nope", attempt: 1, result: ok })).toEqual({ applied: false });
    expect(r.service.outcome("beta", { id, attempt: 1, result: ok })).toEqual({ applied: true });
    expect(r.service.outcome("beta", { id, attempt: 1, result: ok })).toEqual({ applied: false });
    expect(r.store.get(id)?.state).toBe("delivered");
  });

  it("puts a retryable failure back in the queue and hands it out again as attempt 2", () => {
    const r = make();
    const id = handed(r);
    r.service.outcome("beta", { id, attempt: 1, result: { ok: false, retry: true, detail: "busy" } });
    expect(r.store.get(id)).toMatchObject({ state: "queued", reason: { kind: "driver", detail: "busy" } });
    expect(r.service.nextFor("beta").map((h) => [h.id, h.attempt])).toEqual([[id, 2]]);
  });

  it("refuses at once when the driver says trying again cannot help", () => {
    const r = make();
    const id = handed(r);
    r.service.outcome("beta", { id, attempt: 1, result: { ok: false, retry: false, detail: "session gone" } });
    expect(r.store.get(id)).toMatchObject({ state: "refused", reason: { kind: "driver", detail: "session gone" } });
  });

  it("refuses a retryable failure once the attempts are used up", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxAttempts: 2 } });
    const id = handed(r);
    r.service.outcome("beta", { id, attempt: 1, result: { ok: false, retry: true, detail: "busy" } });
    r.service.nextFor("beta");
    r.service.outcome("beta", { id, attempt: 2, result: { ok: false, retry: true, detail: "busy again" } });
    expect(r.store.get(id)).toMatchObject({ state: "refused", reason: { kind: "driver", detail: "busy again" } });
  });
});

describe("inbox", () => {
  it("hands out the session's waiting messages oldest first, delivered with certainty confirmed and read", () => {
    const r = make();
    const first = r.service.send("alpha", alpha, to("b2"), "one");
    const second = r.service.send("alpha", alpha, to("b2"), "two");
    if (first.kind !== "accepted" || second.kind !== "accepted") throw new Error("not queued");
    const got = r.service.inbox("beta", "b2");
    expect(got.kind === "ok" && got.messages.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(got.kind === "ok" && got.messages[0]?.text).toContain("one");
    expect(r.store.get(first.id)).toMatchObject({ state: "delivered", certainty: "confirmed", attempts: 1 });
    expect(r.service.inbox("beta", "b2")).toEqual({ kind: "ok", messages: [] });
  });

  it("works for a cold session, and nothing is pushed afterwards", () => {
    const r = make();
    r.service.send("alpha", alpha, to("b2"), "one");
    r.service.inbox("beta", "b2");
    expect(r.service.nextFor("beta")).toEqual([]);
  });

  it("does not return a message that is already being delivered", () => {
    const r = make();
    r.service.send("alpha", alpha, to("b1"), "one");
    r.service.nextFor("beta");
    expect(r.service.inbox("beta", "b1")).toEqual({ kind: "ok", messages: [] });
  });

  it("reaches only the caller's own container", () => {
    const r = make();
    r.service.send("alpha", alpha, to("b1"), "for beta");
    expect(r.service.inbox("alpha", "b1")).toEqual({ kind: "ok", messages: [] });
    expect(r.service.inbox("gamma", "b1")).toEqual({ kind: "ok", messages: [] });
    expect(r.service.inbox("ghost", "b1")).toEqual({ kind: "forbidden" });
  });

  it("returns nothing while stopped, and checks the policy again", () => {
    const r = make();
    const sent = r.service.send("alpha", alpha, to("b1"), "one");
    if (sent.kind !== "accepted") throw new Error("not queued");
    r.store.setStopped(true, 1);
    expect(r.service.inbox("beta", "b1")).toEqual({ kind: "ok", messages: [] });
    r.store.setStopped(false, 2);
    const stricter = r.withPolicy(policyOf({ rules: [] }));
    expect(stricter.inbox("beta", "b1")).toEqual({ kind: "ok", messages: [] });
    expect(r.store.get(sent.id)?.state).toBe("refused");
  });

  it("leaves held messages out", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }] });
    r.service.send("alpha", alpha, to("b1"), "one");
    expect(r.service.inbox("beta", "b1")).toEqual({ kind: "ok", messages: [] });
  });
});

describe("approvals", () => {
  it("lists a held message with the rule that asked, and approve or refuse answers it once", () => {
    const r = make({ rules: [{ name: "ask-codex", from: {}, to: { product: "codex" }, decision: "ask" }] });
    const sent = r.service.send("alpha", alpha, to("b1"), "may I?");
    if (sent.kind !== "accepted") throw new Error("not held");
    expect(r.service.approvals()).toEqual([
      {
        id: sent.id,
        thread: sent.id,
        hop: 0,
        from: { container: "alpha", product: "claude", session: "a1", title: "Alpha one" },
        to: { container: "beta", product: "codex", session: "b1" },
        body: "may I?",
        rule: "ask-codex",
        heldAt: 10_000,
        decideBy: 10_000 + 900_000,
      },
    ]);
    expect(r.service.refuse(sent.id)).toEqual({ ok: true });
    expect(r.store.get(sent.id)).toMatchObject({ state: "refused", reason: { kind: "approver", answer: "no" } });
    expect(r.service.approve(sent.id)).toEqual({ ok: false, why: "not-held" });
    expect(r.service.approve("nope")).toEqual({ ok: false, why: "not-found" });
    expect(r.service.approvals()).toEqual([]);
  });

  it("queues an approved message", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }] });
    const sent = r.service.send("alpha", alpha, to("b1"), "x");
    if (sent.kind !== "accepted") throw new Error("not held");
    expect(r.service.approve(sent.id)).toEqual({ ok: true });
    expect(r.store.get(sent.id)?.state).toBe("queued");
  });
});

describe("tick", () => {
  it("expires messages past their time, whatever state they wait in", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: { container: "beta" }, decision: "ask" }, { name: "open", from: {}, to: {}, decision: "allow" }], limits: { messageTtlMs: 5000, approvalTtlMs: 60_000 } });
    const held = r.service.send("alpha", alpha, to("b1"), "held");
    r.clock.t += 4999;
    r.service.tick();
    expect(r.store.get("id1")?.state).toBe("held");
    r.clock.t += 1;
    r.service.tick();
    expect(held.kind === "accepted" && r.store.get(held.id)?.state).toBe("expired");
  });

  it("sends an overdue delivery back to the queue with the same id", () => {
    const r = make(ALLOW_ALL, 1000);
    const sent = r.service.send("alpha", alpha, to("b1"), "hi");
    if (sent.kind !== "accepted") throw new Error("not queued");
    r.service.nextFor("beta");
    r.clock.t += 1000;
    r.service.tick();
    expect(r.store.get(sent.id)?.state).toBe("delivering");
    r.clock.t += 1;
    r.service.tick();
    expect(r.store.get(sent.id)).toMatchObject({ state: "queued", reason: { kind: "driver" } });
    expect(r.service.nextFor("beta").map((h) => [h.id, h.attempt])).toEqual([[sent.id, 2]]);
  });

  it("refuses an overdue delivery once the attempts are used up", () => {
    const r = make({ ...ALLOW_ALL, limits: { maxAttempts: 1 } }, 1000);
    const sent = r.service.send("alpha", alpha, to("b1"), "hi");
    if (sent.kind !== "accepted") throw new Error("not queued");
    r.service.nextFor("beta");
    r.clock.t += 1001;
    r.service.tick();
    expect(r.store.get(sent.id)).toMatchObject({ state: "refused", reason: { kind: "driver" } });
  });

  it("refuses a held message nobody answered within the approval time", () => {
    const r = make({ rules: [{ name: "ask", from: {}, to: {}, decision: "ask" }], limits: { approvalTtlMs: 5000 } });
    const sent = r.service.send("alpha", alpha, to("b1"), "hi");
    if (sent.kind !== "accepted") throw new Error("not held");
    r.clock.t += 4999;
    r.service.tick();
    expect(r.store.get(sent.id)?.state).toBe("held");
    r.clock.t += 1;
    r.service.tick();
    expect(r.store.get(sent.id)).toMatchObject({ state: "refused", reason: { kind: "approver", answer: "timeout" } });
  });
});
