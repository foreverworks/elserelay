import { afterEach, describe, expect, it } from "vitest";
import { ALLOWED_METHODS, connectUnix, createCodexDriver } from "../src/drivers/codex.js";
import type { Driver } from "../src/drivers/driver.js";
import { startFakeServer, thread, type FakeServer, type Handler } from "./fake-app-server.js";

const NOW = 1_800_000_000_000;
const ID = "01a20e02-9907-7ef2-adae-4a2cc98c5a0b";
const unknownThread = { error: { code: -32600, message: `thread not found: ${ID}` } } as const;
const turn = { result: { turn: { id: "t1", status: "inProgress", items: [] } } } as const;
const queued = { result: { queuedSubmission: { id: "q1", input: [] } } } as const;
const readOf = (status: unknown): Handler => () => ({ result: { thread: thread(ID, status), readState: null } });

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = async (handlers: Record<string, Handler>, timeoutMs = 2000): Promise<{ driver: Driver; server: FakeServer }> => {
  server = await startFakeServer(handlers);
  const driver = createCodexDriver({ connect: connectUnix(server.path), now: () => NOW, newId: () => "msg-1", timeoutMs });
  return { driver, server };
};

describe("capabilities", () => {
  it("pushes, wakes an idle thread, does not join a turn and confirms", async () => {
    const driver = createCodexDriver({ connect: connectUnix("/nonexistent") });
    expect(driver.product).toBe("codex");
    expect(driver.capabilities()).toEqual({ push: true, wakesIdle: true, joinsTurn: false, certainty: "confirmed" });
  });
});

describe("list", () => {
  it("joins thread/list with thread/loaded/list and reads titles", async () => {
    const hour = 3600;
    const fresh = NOW / 1000 - 60;
    const { driver, server: s } = await start({
      "thread/list": () => ({
        result: {
          data: [
            thread("idle-new", { type: "idle" }, { updatedAt: fresh, name: "Fix the build" }),
            thread("idle-old", { type: "idle" }, { updatedAt: NOW / 1000 - hour - 1 }),
            thread("busy", { type: "active", activeFlags: ["waitingOnApproval"] }, { updatedAt: fresh }),
            thread("stored", { type: "notLoaded" }, { updatedAt: fresh }),
            thread("not-in-memory", { type: "idle" }, { updatedAt: fresh }),
            thread("broken", { type: "systemError" }, { updatedAt: fresh }),
            thread("hour-exact", { type: "idle" }, { updatedAt: NOW / 1000 - hour }),
          ],
          readStates: {},
          nextCursor: null,
          backwardsCursor: null,
        },
      }),
      "thread/loaded/list": () => ({ result: { data: ["idle-new", "idle-old", "busy", "stored", "broken", "hour-exact", "unlisted"], nextCursor: null } }),
    });
    expect(await driver.list()).toEqual([
      { session: "idle-new", title: "Fix the build", activity: "idle" },
      { session: "idle-old", title: null, activity: "cold" },
      { session: "busy", title: null, activity: "busy" },
      { session: "stored", title: null, activity: "cold" },
      { session: "not-in-memory", title: null, activity: "cold" },
      { session: "broken", title: null, activity: "unknown" },
      { session: "hour-exact", title: null, activity: "idle" },
    ]);
    const asked = s.received.find((frame) => frame.method === "thread/list");
    expect(asked?.params).toEqual({ limit: 50, sortKey: "updated_at", sortDirection: "desc" });
  });

  it("keeps the newest 50 when the server returns more", async () => {
    const many = Array.from({ length: 80 }, (_, i) => thread(`t${i}`, { type: "idle" }, { updatedAt: NOW / 1000 }));
    const { driver } = await start({
      "thread/list": () => ({ result: { data: many, readStates: null, nextCursor: "more", backwardsCursor: null } }),
      "thread/loaded/list": () => ({ result: { data: many.map((t) => t.id), nextCursor: null } }),
    });
    const seen = await driver.list();
    expect(seen).toHaveLength(50);
    expect(seen[0]?.session).toBe("t0");
  });

  it("throws, and does not return an empty list, when the app-server cannot be reached", async () => {
    const driver = createCodexDriver({ connect: connectUnix("/nonexistent/app.sock") });
    await expect(driver.list()).rejects.toThrow(/connect/);
  });

  it("throws on a reply in a shape it does not know", async () => {
    const { driver } = await start({ "thread/list": () => ({ result: { data: "no" } }), "thread/loaded/list": () => ({ result: { data: [] } }) });
    await expect(driver.list()).rejects.toThrow(/shape/);
  });
});

describe("status", () => {
  it("reads one thread", async () => {
    const { driver } = await start({ "thread/read": () => ({ result: { thread: thread(ID, { type: "active", activeFlags: [] }, { updatedAt: NOW / 1000 - 99999, name: "Review" }), readState: null } }) });
    expect(await driver.status(ID)).toEqual({ session: ID, title: "Review", activity: "busy" });
  });

  it("is null for a thread the app-server does not know", async () => {
    const { driver } = await start({ "thread/read": () => unknownThread });
    expect(await driver.status(ID)).toBeNull();
  });

  it("reads a stored thread that is not loaded as cold", async () => {
    const { driver } = await start({ "thread/read": readOf({ type: "notLoaded" }) });
    expect((await driver.status(ID))?.activity).toBe("cold");
  });
});

describe("deliver", () => {
  it("starts a turn on an idle thread with the text and no overrides", async () => {
    const { driver, server: s } = await start({ "thread/read": readOf({ type: "idle" }), "turn/start": () => turn });
    expect(await driver.deliver(ID, "hello there")).toEqual({ ok: true, certainty: "confirmed" });
    const sent = s.received.find((frame) => frame.method === "turn/start");
    expect(sent?.params).toEqual({ threadId: ID, input: [{ type: "text", text: "hello there", text_elements: [] }] });
    expect(s.methods()).not.toContain("thread/queue/add");
  });

  it("queues on a busy thread, and does so while it waits on an approval", async () => {
    for (const flags of [[], ["waitingOnApproval"], ["waitingOnUserInput"]]) {
      const { driver, server: s } = await start({ "thread/read": readOf({ type: "active", activeFlags: flags }), "thread/queue/add": () => queued });
      expect(await driver.deliver(ID, "later")).toEqual({ ok: true, certainty: "confirmed" });
      const sent = s.received.find((frame) => frame.method === "thread/queue/add");
      expect(sent?.params).toEqual({ threadId: ID, clientUserMessageId: "msg-1", input: [{ type: "text", text: "later", text_elements: [] }] });
      expect(s.methods()).not.toContain("turn/start");
      await s.close();
      server = undefined;
    }
  });

  it("passes the text on unchanged", async () => {
    const { driver, server: s } = await start({ "thread/read": readOf({ type: "idle" }), "turn/start": () => turn });
    const text = "line one\n\n  \"quoted\" é\u{1F600} <b>";
    await driver.deliver(ID, text);
    const sent = s.received.find((frame) => frame.method === "turn/start");
    expect(sent?.params).toMatchObject({ input: [{ text }] });
  });

  it.each(["notLoaded", "systemError"])("refuses a %s thread without sending anything and says why", async (type) => {
    const { driver, server: s } = await start({ "thread/read": readOf({ type }) });
    const result = await driver.deliver(ID, "hi");
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(result.ok === false && result.detail).toContain(type);
    expect(result.ok === false && result.detail).toContain("never resumes");
    expect(s.methods().filter((m) => m !== "initialize" && m !== "initialized")).toEqual(["thread/read"]);
  });

  it("does not retry for a thread the server does not know", async () => {
    const { driver } = await start({ "thread/read": () => unknownThread });
    expect(await driver.deliver(ID, "hi")).toMatchObject({ ok: false, retry: false });
  });

  it("does not retry when the thread vanishes between the read and the send", async () => {
    const { driver } = await start({ "thread/read": readOf({ type: "idle" }), "turn/start": () => unknownThread });
    expect(await driver.deliver(ID, "hi")).toMatchObject({ ok: false, retry: false });
  });

  it("retries when the server refuses the send for another reason", async () => {
    const { driver } = await start({ "thread/read": readOf({ type: "idle" }), "turn/start": () => ({ error: { code: -32603, message: "busy" } }) });
    expect(await driver.deliver(ID, "hi")).toMatchObject({ ok: false, retry: true });
  });

  it("retries when the app-server cannot be reached", async () => {
    const driver = createCodexDriver({ connect: connectUnix("/nonexistent/app.sock") });
    expect(await driver.deliver(ID, "hi")).toMatchObject({ ok: false, retry: true });
  });

  it("retries when the read times out, since nothing was sent", async () => {
    const { driver } = await start({ "thread/read": () => "hang" }, 100);
    expect(await driver.deliver(ID, "hi")).toMatchObject({ ok: false, retry: true });
  });

  it.each([
    ["turn/start", { type: "idle" }],
    ["thread/queue/add", { type: "active", activeFlags: [] }],
  ])("does not retry a %s that timed out, and says the outcome is unknown", async (method, status) => {
    const { driver } = await start({ "thread/read": readOf(status), [method]: () => "hang" }, 150);
    const result = await driver.deliver(ID, "hi");
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(result.ok === false && result.detail).toContain("unknown");
    expect(result.ok === false && result.detail).toContain(method);
  });

  it("does not retry a send whose connection dropped before the answer", async () => {
    const { driver } = await start({ "thread/read": readOf({ type: "idle" }), "turn/start": () => "drop" });
    const result = await driver.deliver(ID, "hi");
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(result.ok === false && result.detail).toContain("unknown");
  });

  it("does not retry a send answered in a shape it does not know", async () => {
    const { driver } = await start({ "thread/read": readOf({ type: "idle" }), "turn/start": () => ({ result: {} }) });
    expect(await driver.deliver(ID, "hi")).toMatchObject({ ok: false, retry: false });
  });

  it("refuses a status it does not know", async () => {
    const { driver } = await start({ "thread/read": readOf({ type: "somethingNew" }) });
    expect(await driver.deliver(ID, "hi")).toMatchObject({ ok: false, retry: false });
  });
});

describe("connection", () => {
  it("declares the experimental API, which thread/queue/add needs, and then sends initialized", async () => {
    const { driver, server: s } = await start({ "thread/read": readOf({ type: "idle" }), "turn/start": () => turn });
    await driver.deliver(ID, "hi");
    const [init, initialized] = s.received;
    expect(init?.method).toBe("initialize");
    expect(init?.params).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(initialized).toMatchObject({ method: "initialized" });
    expect(initialized?.id).toBeUndefined();
  });

  it("opens one connection for several calls", async () => {
    const { driver, server: s } = await start({ "thread/read": readOf({ type: "idle" }) });
    await Promise.all([driver.status(ID), driver.status(ID), driver.status(ID)]);
    expect(s.methods().filter((m) => m === "initialize")).toHaveLength(1);
  });

  it("matches answers to requests that finish out of order", async () => {
    const delays: Record<string, number> = { slow: 150, fast: 0 };
    const { driver } = await start({
      "thread/read": async (params) => {
        const id = (params as { threadId: string }).threadId;
        await new Promise((resolve) => setTimeout(resolve, delays[id] ?? 0));
        return { result: { thread: thread(id, { type: "idle" }, { name: id }), readState: null } };
      },
    });
    const [slow, fast] = await Promise.all([driver.status("slow"), driver.status("fast")]);
    expect(slow?.title).toBe("slow");
    expect(fast?.title).toBe("fast");
  });

  it("reconnects on the next call after a close", async () => {
    const { driver, server: s } = await start({ "thread/read": readOf({ type: "idle" }), "turn/start": () => turn });
    expect(await driver.deliver(ID, "one")).toMatchObject({ ok: true });
    s.dropClients();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await driver.deliver(ID, "two")).toMatchObject({ ok: true });
    expect(s.methods().filter((m) => m === "initialize")).toHaveLength(2);
  });

  it("recovers after the app-server was not there", async () => {
    server = await startFakeServer({ "thread/read": readOf({ type: "idle" }), "turn/start": () => turn });
    const path = server.path;
    let up = false;
    const real = connectUnix(path);
    const driver = createCodexDriver({ connect: (handlers) => (up ? real(handlers) : Promise.reject(new Error("refused"))), timeoutMs: 1000 });
    expect(await driver.deliver(ID, "hi")).toMatchObject({ ok: false, retry: true });
    up = true;
    expect(await driver.deliver(ID, "hi")).toMatchObject({ ok: true });
  });

  it("never answers a request the server makes", async () => {
    const { driver, server: s } = await start({ "thread/read": readOf({ type: "active", activeFlags: ["waitingOnApproval"] }), "thread/queue/add": () => queued });
    await driver.status(ID);
    s.sendRequest("item/commandExecution/requestApproval", { threadId: ID, command: "rm -rf /" });
    await driver.deliver(ID, "hi");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.received.filter((frame) => frame.id === 9001)).toEqual([]);
    expect(s.received.filter((frame) => frame.result !== undefined || frame.error !== undefined)).toEqual([]);
  });

  it("ignores frames it cannot read and answers it was not waiting for", async () => {
    const { driver, server: s } = await start({ "thread/read": readOf({ type: "idle" }) });
    await driver.status(ID);
    s.sendRaw("not json");
    s.sendRaw(JSON.stringify([1, 2]));
    s.sendRaw(JSON.stringify({ id: 4242, result: {} }));
    s.sendRaw(JSON.stringify({ method: "thread/started", params: {} }));
    expect(await driver.status(ID)).not.toBeNull();
  });
});

describe("the wire", () => {
  it("sends only methods from the closed list, and never resumes, steers or injects", async () => {
    const handlers = {
      "thread/list": () => ({ result: { data: [thread(ID, { type: "idle" })], readStates: {}, nextCursor: null, backwardsCursor: null } }),
      "thread/loaded/list": () => ({ result: { data: [ID], nextCursor: null } }),
      "thread/read": readOf({ type: "idle" }),
      "turn/start": () => turn,
      "thread/queue/add": () => queued,
    };
    const { driver, server: s } = await start(handlers);
    await driver.list();
    await driver.status(ID);
    await driver.deliver(ID, "idle path");
    const idle = s.methods();
    await s.close();
    server = await startFakeServer({ ...handlers, "thread/read": readOf({ type: "active", activeFlags: [] }) });
    const busy = createCodexDriver({ connect: connectUnix(server.path) });
    await busy.deliver(ID, "busy path");
    for (const sent of [...idle, ...server.methods()]) expect(ALLOWED_METHODS as readonly string[]).toContain(sent);
    expect(idle).toContain("turn/start");
    expect(ALLOWED_METHODS).toEqual(["initialize", "initialized", "thread/list", "thread/loaded/list", "thread/read", "turn/start", "thread/queue/add"]);
    expect(server.methods()).toContain("thread/queue/add");
  });
});
