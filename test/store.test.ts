import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Peer } from "../src/core/types.js";
import { openStore } from "../src/store/sqlite.js";
import type { Store } from "../src/store/types.js";
import { addr, events, message } from "./fixtures.js";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});
afterEach(() => store.close());

const peer = (session: string, changes: Partial<Peer> = {}): Peer => ({
  container: "ignored", product: "fake", session, title: null, activity: "idle", seenAt: 1, ...changes,
});

/** Walks a message to `delivering`. */
function handOut(id: string, at = 10): void {
  store.apply(id, events.queue, at);
  store.apply(id, { kind: "hand-out", attempt: 1 }, at + 1);
}

describe("receive and get", () => {
  it("stores a message as received and reads it back unchanged", () => {
    const m = message("m1", { replyTo: "m0", from: { ...addr("alpha", "s9", "claude"), title: null } });
    const t = store.receive(m, 50);
    expect(t).toEqual({ message: m, state: "received", attempts: 0, pulled: false, reason: null, certainty: null, updatedAt: 50 });
    expect(store.get("m1")).toEqual(t);
  });

  it("returns null for an id it does not hold, and refuses a second message with the same id", () => {
    expect(store.get("nope")).toBeNull();
    store.receive(message("m1"), 1);
    expect(() => store.receive(message("m1"), 2)).toThrow();
    expect(store.audit(0)).toHaveLength(1);
  });
});

describe("apply", () => {
  it("moves the message, records the reason, the attempt and the certainty, and audits each step", () => {
    store.receive(message("m1"), 1);
    expect(store.apply("m1", events.queue, 2)?.state).toBe("queued");
    expect(store.apply("m1", { kind: "hand-out", attempt: 1 }, 3)?.attempts).toBe(1);
    const retried = store.apply("m1", events.retry, 4);
    expect(retried?.state).toBe("queued");
    expect(retried?.reason).toEqual({ kind: "driver", detail: "busy" });
    store.apply("m1", { kind: "hand-out", attempt: 2 }, 5);
    const done = store.apply("m1", { kind: "deliver", certainty: "confirmed" }, 6);
    expect(done).toEqual({ ...store.get("m1"), state: "delivered", attempts: 2, certainty: "confirmed", updatedAt: 6 });
    expect(store.audit(0).map((a) => [a.event, a.state, a.at])).toEqual([
      ["receive", "received", 1],
      ["queue", "queued", 2],
      ["hand-out", "delivering", 3],
      ["retry", "queued", 4],
      ["hand-out", "delivering", 5],
      ["deliver", "delivered", 6],
    ]);
    expect(store.audit(0)[3]?.detail).toEqual({ kind: "driver", detail: "busy" });
    expect(store.audit(0)[0]).toMatchObject({ message: "m1", thread: "t1", from: addr("alpha"), to: addr("beta"), detail: null });
  });

  it("returns null for an unknown id", () => {
    expect(store.apply("nope", events.queue, 1)).toBeNull();
  });

  it("throws on an illegal event and changes nothing, not even the audit", () => {
    store.receive(message("m1"), 1);
    expect(() => store.apply("m1", events.deliver, 2)).toThrow(/received/);
    expect(store.get("m1")?.state).toBe("received");
    expect(store.audit(0)).toHaveLength(1);
    store.apply("m1", events.refuse, 3);
    expect(() => store.apply("m1", events.queue, 4)).toThrow(/final/);
    expect(store.audit(0)).toHaveLength(2);
  });

  it("keeps the refusal reason", () => {
    store.receive(message("m1"), 1);
    const t = store.apply("m1", { kind: "refuse", reason: { kind: "rate", limit: 2, windowMs: 9 } }, 2);
    expect(t?.reason).toEqual({ kind: "rate", limit: 2, windowMs: 9 });
    expect(store.get("m1")?.reason).toEqual({ kind: "rate", limit: 2, windowMs: 9 });
  });
});

describe("queries", () => {
  it("held lists held messages, oldest first", () => {
    store.receive(message("a"), 1);
    store.receive(message("b"), 2);
    store.receive(message("c"), 3);
    store.apply("b", events.hold, 4);
    store.apply("a", events.hold, 5);
    expect(store.held().map((t) => t.message.id)).toEqual(["a", "b"]);
    store.apply("a", events.approve, 6);
    expect(store.held().map((t) => t.message.id)).toEqual(["b"]);
  });

  it("queued lists one container's queued messages, oldest first", () => {
    store.receive(message("a"), 1);
    store.receive(message("b", { to: addr("gamma") }), 2);
    store.receive(message("c"), 3);
    for (const id of ["c", "a", "b"]) store.apply(id, events.queue, 9);
    expect(store.queued("beta").map((t) => t.message.id)).toEqual(["a", "c"]);
    expect(store.queued("gamma").map((t) => t.message.id)).toEqual(["b"]);
    expect(store.queued("nobody")).toEqual([]);
    store.apply("a", { kind: "hand-out", attempt: 1 }, 10);
    expect(store.queued("beta").map((t) => t.message.id)).toEqual(["c"]);
  });

  it("overdue lists delivering messages handed out before the cut", () => {
    for (const id of ["a", "b", "c"]) store.receive(message(id), 1);
    handOut("a", 10);
    handOut("b", 20);
    store.apply("c", events.queue, 5);
    expect(store.overdue(11).map((t) => t.message.id)).toEqual([]);
    expect(store.overdue(12).map((t) => t.message.id)).toEqual(["a"]);
    expect(store.overdue(1000).map((t) => t.message.id)).toEqual(["a", "b"]);
  });

  it("overdue leaves out a message the session pulled itself", () => {
    store.receive(message("a"), 1);
    store.receive(message("b"), 1);
    handOut("a", 10);
    store.apply("b", events.queue, 10);
    store.apply("b", events.pull, 11);
    expect(store.get("b")).toMatchObject({ state: "delivering", pulled: true, attempts: 0 });
    expect(store.overdue(1000).map((t) => t.message.id)).toEqual(["a"]);
  });

  it("applyIf writes only while the message is still as it was read", () => {
    store.receive(message("a"), 1);
    store.apply("a", events.queue, 2);
    const read = store.get("a");
    if (read === null) throw new Error("missing");
    store.apply("a", events.hold, 3);
    expect(store.applyIf("a", events.expire, 4, read)).toBeNull();
    expect(store.get("a")).toMatchObject({ state: "held", updatedAt: 3 });
    expect(store.audit(0).map((e) => e.event)).toEqual(["receive", "queue", "hold"]);
    const now = store.get("a");
    if (now === null) throw new Error("missing");
    expect(store.applyIf("a", events.expire, 5, now)?.state).toBe("expired");
    expect(store.applyIf("nope", events.expire, 5, now)).toBeNull();
  });

  it("a refused message keeps no body, only its length and hash", () => {
    store.receive(message("a", { body: "secret ééé" }), 1);
    const before = store.get("a");
    store.apply("a", events.refuse, 2);
    const after = store.get("a");
    expect(after?.message.body).toBe("");
    expect(after?.message.bodyChars).toBe(10);
    expect(after?.message.bodySha256).toBe(before?.message.bodySha256);
    expect(after?.message.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("expired lists what is past its expiry and not final", () => {
    store.receive(message("a", { expiresAt: 100 }), 1);
    store.receive(message("b", { expiresAt: 200 }), 1);
    store.receive(message("c", { expiresAt: 100 }), 1);
    store.apply("a", events.queue, 2);
    store.apply("c", events.refuse, 2);
    expect(store.expired(99)).toEqual([]);
    expect(store.expired(100).map((t) => t.message.id)).toEqual(["a"]);
    expect(store.expired(500).map((t) => t.message.id)).toEqual(["a", "b"]);
  });

  it("thread lists one thread, oldest first", () => {
    store.receive(message("a", { thread: "x", createdAt: 5 }), 1);
    store.receive(message("b", { thread: "y", createdAt: 6 }), 1);
    store.receive(message("c", { thread: "x", createdAt: 7, hop: 1, replyTo: "a" }), 1);
    expect(store.thread("x").map((t) => t.message.id)).toEqual(["a", "c"]);
    expect(store.thread("none")).toEqual([]);
  });

  it("sentSince counts one pair's messages since a time, leaving out refused ones", () => {
    store.receive(message("a"), 10);
    store.receive(message("b"), 20);
    store.receive(message("c"), 30);
    store.receive(message("d", { from: { ...addr("other"), title: null } }), 30);
    store.receive(message("e", { to: addr("gamma") }), 30);
    store.apply("c", events.refuse, 31);
    expect(store.sentSince("alpha", "beta", 0)).toBe(2);
    expect(store.sentSince("alpha", "beta", 20)).toBe(1);
    expect(store.sentSince("alpha", "beta", 21)).toBe(0);
    expect(store.sentSince("other", "beta", 0)).toBe(1);
    expect(store.sentSince("beta", "alpha", 0)).toBe(0);
  });
});

describe("refusals and the hops a session was handed", () => {
  it("refusedSince counts one container's refused messages since a time", () => {
    for (const [id, at] of [["a", 10], ["b", 20], ["c", 30]] as const) {
      store.receive(message(id), at);
      store.apply(id, events.refuse, at + 1);
    }
    store.receive(message("d"), 30);
    store.receive(message("e", { from: { ...addr("other"), title: null } }), 30);
    store.apply("e", events.refuse, 31);
    expect(store.refusedSince("alpha", 0)).toBe(3);
    expect(store.refusedSince("alpha", 20)).toBe(2);
    expect(store.refusedSince("other", 0)).toBe(1);
  });

  it("noteRefusalLimit writes one line per window and container, and shows it in the control audit", () => {
    expect(store.noteRefusalLimit("alpha", 100, 60, 1000)).toBe(true);
    expect(store.noteRefusalLimit("alpha", 1099, 60, 1000)).toBe(false);
    expect(store.noteRefusalLimit("other", 1099, 60, 1000)).toBe(true);
    expect(store.noteRefusalLimit("alpha", 1100, 60, 1000)).toBe(true);
    store.setStopped(true, 500);
    expect(store.controlAudit(0)).toEqual([
      { at: 100, action: "refusals-limited", container: "alpha", limit: 60, windowMs: 1000 },
      { at: 500, action: "stop" },
      { at: 1099, action: "refusals-limited", container: "other", limit: 60, windowMs: 1000 },
      { at: 1100, action: "refusals-limited", container: "alpha", limit: 60, windowMs: 1000 },
    ]);
  });

  it("lastReceived finds the newest message handed to a session by a container within the time", () => {
    const from = { ...addr("alpha"), title: null };
    for (const [id, hop] of [["a", 0], ["b", 1], ["c", 2], ["d", 3]] as const) {
      store.receive(message(id, { hop, from, createdAt: 1 }), 1);
      store.apply(id, events.queue, 2);
    }
    store.receive(message("e", { hop: 9, from: { ...addr("other"), title: null } }), 1);
    store.apply("e", events.queue, 2);
    store.apply("e", { kind: "hand-out", attempt: 1 }, 3);
    store.apply("a", { kind: "hand-out", attempt: 1 }, 10);
    store.apply("a", events.deliver, 11);
    store.apply("b", events.pull, 20);
    store.apply("c", { kind: "hand-out", attempt: 1 }, 30);
    store.apply("c", events.retry, 31);
    // a was delivered, b is pulled and not yet confirmed, c went back to the queue, d never left, e is from elsewhere.
    expect(store.lastReceived(addr("beta"), "alpha", 0)?.message.id).toBe("b");
    expect(store.lastReceived(addr("beta"), "alpha", 12)?.message.id).toBe("b");
    expect(store.lastReceived(addr("beta"), "alpha", 21)).toBeNull();
    expect(store.lastReceived(addr("beta", "other"), "alpha", 0)).toBeNull();
    expect(store.lastReceived(addr("beta"), "nobody", 0)).toBeNull();
  });
});

describe("inbox and markRead", () => {
  it("lists what is addressed to a session and was put in front of it, oldest first", () => {
    store.receive(message("a", { createdAt: 1 }), 1);
    store.receive(message("b", { createdAt: 2 }), 1);
    store.receive(message("c", { createdAt: 3 }), 1);
    store.receive(message("d", { createdAt: 4 }), 1);
    store.receive(message("e", { createdAt: 5, to: addr("beta", "other") }), 1);
    store.receive(message("f", { createdAt: 6 }), 1);
    store.apply("a", events.queue, 2);
    store.apply("b", events.hold, 2);
    store.apply("c", events.refuse, 2);
    handOut("d");
    store.apply("e", events.queue, 2);
    store.apply("f", events.queue, 2);
    store.apply("f", { kind: "hand-out", attempt: 1 }, 3);
    store.apply("f", events.deliver, 4);
    expect(store.inbox(addr("beta"), false).map((t) => t.message.id)).toEqual(["a", "d", "f"]);
    expect(store.inbox(addr("beta", "other"), false).map((t) => t.message.id)).toEqual(["e"]);
    expect(store.inbox(addr("beta", "s1", "codex"), false)).toEqual([]);
  });

  it("unreadOnly leaves out what markRead has seen; marking twice or an unknown id is harmless", () => {
    for (const id of ["a", "b"]) {
      store.receive(message(id), 1);
      store.apply(id, events.queue, 2);
    }
    store.markRead(addr("beta"), ["a", "nope"], 5);
    store.markRead(addr("beta"), ["a"], 6);
    expect(store.inbox(addr("beta"), true).map((t) => t.message.id)).toEqual(["b"]);
    expect(store.inbox(addr("beta"), false).map((t) => t.message.id)).toEqual(["a", "b"]);
  });

  it("a session cannot mark another session's message read", () => {
    store.receive(message("a"), 1);
    store.apply("a", events.queue, 2);
    store.markRead(addr("beta", "intruder"), ["a"], 5);
    expect(store.inbox(addr("beta"), true)).toHaveLength(1);
  });
});

describe("peers", () => {
  it("reportPeers replaces what that container's product had reported and nothing else", () => {
    store.reportPeers("c1", "claude", [peer("a"), peer("b", { title: "B" })]);
    store.reportPeers("c1", "codex", [peer("x")]);
    store.reportPeers("c2", "claude", [peer("y", { activity: "cold", seenAt: 7 })]);
    store.reportPeers("c1", "claude", [peer("b", { title: "B2", activity: "busy" }), peer("z")]);
    expect(store.peers().map((p) => [p.container, p.product, p.session, p.title, p.activity])).toEqual([
      ["c1", "claude", "b", "B2", "busy"],
      ["c1", "claude", "z", null, "idle"],
      ["c1", "codex", "x", null, "idle"],
      ["c2", "claude", "y", null, "cold"],
    ]);
    expect(store.peers().find((p) => p.session === "y")?.seenAt).toBe(7);
  });

  it("an empty report removes them all", () => {
    store.reportPeers("c1", "claude", [peer("a")]);
    store.reportPeers("c1", "claude", []);
    expect(store.peers()).toEqual([]);
  });
});

describe("stop switch", () => {
  it("is off at first and holds what it is set to", () => {
    expect(store.stopped()).toBe(false);
    store.setStopped(true, 1);
    expect(store.stopped()).toBe(true);
    store.setStopped(true, 2);
    expect(store.stopped()).toBe(true);
    store.setStopped(false, 3);
    expect(store.stopped()).toBe(false);
  });
});

describe("control log", () => {
  it("records every stop and start, also a repeat, oldest first", () => {
    store.setStopped(true, 10);
    store.setStopped(true, 20);
    store.setStopped(false, 30);
    expect(store.controlAudit(0)).toEqual([
      { at: 10, action: "stop" },
      { at: 20, action: "stop" },
      { at: 30, action: "start" },
    ]);
    expect(store.controlAudit(21)).toEqual([{ at: 30, action: "start" }]);
  });
});

describe("wasApproved", () => {
  it("is true only for a message that was approved, whatever happens to it later", () => {
    store.receive(message("a"), 1);
    store.receive(message("b"), 1);
    store.apply("a", events.hold, 2);
    store.apply("b", events.queue, 2);
    expect(store.wasApproved("a")).toBe(false);
    store.apply("a", events.approve, 3);
    store.apply("a", events["hand-out"], 4);
    store.apply("a", events.retry, 5);
    expect(store.wasApproved("a")).toBe(true);
    expect(store.wasApproved("b")).toBe(false);
    expect(store.wasApproved("nope")).toBe(false);
  });
});

describe("audit", () => {
  it("lists entries from a time on, in order", () => {
    store.receive(message("a"), 10);
    store.apply("a", events.queue, 20);
    store.apply("a", events.expire, 30);
    expect(store.audit(20).map((e) => e.event)).toEqual(["queue", "expire"]);
    expect(store.audit(31)).toEqual([]);
  });

  it("holds the same reason the message carries", () => {
    store.receive(message("a"), 10);
    store.apply("a", { kind: "refuse", reason: { kind: "policy", rule: null } }, 11);
    expect(store.audit(0)[1]).toMatchObject({ event: "refuse", state: "refused", detail: { kind: "policy", rule: null } });
  });
});

describe("a store file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agw-store-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps everything across a reopen, and in WAL mode", () => {
    const path = join(dir, "gw.sqlite");
    const first = openStore(path);
    first.receive(message("a"), 1);
    first.apply("a", events.queue, 2);
    first.reportPeers("c1", "claude", [peer("p")]);
    first.setStopped(true, 3);
    first.close();

    const second = openStore(path);
    expect(second.get("a")?.state).toBe("queued");
    expect(second.queued("beta")).toHaveLength(1);
    expect(second.peers()).toHaveLength(1);
    expect(second.stopped()).toBe(true);
    expect(second.audit(0)).toHaveLength(2);
    second.apply("a", { kind: "hand-out", attempt: 1 }, 4);
    second.close();

    const raw = new DatabaseSync(path);
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    raw.close();
  });

  it("refuses a file written by another schema version", () => {
    const path = join(dir, "future.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => openStore(path)).toThrow(/version 99/);
  });

  it("the audit table refuses UPDATE and DELETE, also from another connection", () => {
    const path = join(dir, "gw.sqlite");
    const s = openStore(path);
    s.receive(message("a"), 1);
    s.close();
    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE audit SET state = 'delivered'")).toThrow(/never changed/);
    expect(() => raw.exec("DELETE FROM audit")).toThrow(/never removed/);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM audit").get()).toEqual({ n: 1 });
    raw.close();
  });

  it("the control log refuses UPDATE and DELETE like the audit", () => {
    const path = join(dir, "gw.sqlite");
    const s = openStore(path);
    s.setStopped(true, 1);
    s.close();
    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE control_log SET action = 'start'")).toThrow(/never changed/);
    expect(() => raw.exec("DELETE FROM control_log")).toThrow(/never removed/);
    raw.close();
  });

  /** A file as an older build left it: the version 3 additions removed again, whatever the rows hold. */
  function downgrade(path: string, version: 1 | 2): void {
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE refusal_notices");
    raw.exec("DROP INDEX messages_by_sender");
    for (const column of ["body_chars", "body_sha256", "pulled"]) raw.exec(`ALTER TABLE messages DROP COLUMN ${column}`);
    if (version === 1) raw.exec("DROP TABLE control_log");
    raw.exec(`PRAGMA user_version = ${version}`);
    raw.close();
  }

  it("opens a version 1 file, adds the control log and keeps its messages", () => {
    const path = join(dir, "old.sqlite");
    const first = openStore(path);
    first.receive(message("a"), 1);
    first.close();
    downgrade(path, 1);

    const second = openStore(path);
    expect(second.get("a")?.state).toBe("received");
    second.setStopped(true, 5);
    expect(second.controlAudit(0)).toEqual([{ at: 5, action: "stop" }]);
    second.close();
  });

  it("opens a version 2 file: hashes every body, wipes the text of refused messages, and rewords a lost outcome", () => {
    const path = join(dir, "v2.sqlite");
    const first = openStore(path);
    first.receive(message("kept", { body: "stay" }), 1);
    first.apply("kept", events.queue, 2);
    first.receive(message("gone", { body: "secret" }), 1);
    first.apply("gone", events.queue, 2);
    first.apply("gone", events.refuse, 3);
    first.receive(message("lost", { body: "again" }), 1);
    first.apply("lost", events.queue, 2);
    first.apply("lost", { kind: "hand-out", attempt: 1 }, 3);
    first.apply("lost", { kind: "retry", reason: { kind: "driver", detail: "no outcome within 1000 ms" } }, 4);
    first.close();
    downgrade(path, 2);
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE messages SET body = 'secret' WHERE id = 'gone'");
    raw.close();

    const second = openStore(path);
    const hash = (text: string): string => message("x", { body: text }).bodySha256;
    expect(second.get("kept")?.message).toMatchObject({ body: "stay", bodyChars: 4, bodySha256: hash("stay") });
    expect(second.get("gone")?.message).toMatchObject({ body: "", bodyChars: 6, bodySha256: hash("secret") });
    expect(second.get("lost")).toMatchObject({ state: "queued", pulled: false, reason: { kind: "no-outcome", ms: 1000 } });
    expect(second.noteRefusalLimit("alpha", 1, 60, 1000)).toBe(true);
    second.close();
    const again = new DatabaseSync(path);
    expect(again.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    again.close();
  });

  it("the refusal notices refuse UPDATE and DELETE like the control log", () => {
    const path = join(dir, "gw.sqlite");
    const s = openStore(path);
    s.noteRefusalLimit("alpha", 1, 60, 1000);
    s.close();
    const raw = new DatabaseSync(path);
    expect(() => raw.exec("UPDATE refusal_notices SET container = 'x'")).toThrow(/never changed/);
    expect(() => raw.exec("DELETE FROM refusal_notices")).toThrow(/never removed/);
    raw.close();
  });

  it("the tables are strict", () => {
    const path = join(dir, "gw.sqlite");
    openStore(path).close();
    const raw = new DatabaseSync(path);
    expect(() => raw.exec("INSERT INTO control (name, value, at) VALUES ('x', 'not a number', 1)")).toThrow();
    raw.close();
  });
});
