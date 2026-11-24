import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOW_ALL } from "./broker-fixtures.js";
import { adapterUrl, call, fakeAdapter, mcpClient, startHarness, TOKENS, waitFor } from "./http-rig.js";
import type { Harness } from "./http-rig.js";

let h: Harness;
let pingEvery: (() => void) | undefined;
beforeAll(async () => {
  h = await startHarness({
    policy: ALLOW_ALL,
    effects: {
      every: (ms, fn) => {
        if (ms === 20_000) pingEvery = fn;
        const timer = setInterval(fn, ms);
        return () => clearInterval(timer);
      },
    },
  });
});
afterAll(() => h.close());

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const status = async (path: string, init: RequestInit): Promise<number> => {
  const res = await fetch(adapterUrl(h, path), init);
  await res.arrayBuffer();
  return res.status;
};
const post = (path: string, token: string | undefined, body: string): Promise<number> =>
  status(path, { method: "POST", headers: { ...(token === undefined ? {} : bearer(token)), "content-type": "application/json" }, body });

const REPORT = JSON.stringify({ product: "claude", capabilities: { push: true, wakesIdle: true, joinsTurn: false, certainty: "confirmed" }, sessions: [] });

describe("the adapter channel", () => {
  it("answers 401 without a token and with a wrong one, on every route", async () => {
    for (const path of ["/adapter/stream", "/adapter/report", "/adapter/outcome", "/adapter/inbox"]) {
      const method = path === "/adapter/stream" ? "GET" : "POST";
      expect(await status(path, { method })).toBe(401);
      expect(await status(path, { method, headers: bearer("not-a-token-0123456789") })).toBe(401);
      expect(await status(path, { method, headers: { authorization: "Basic abc" } })).toBe(401);
    }
  });

  it("answers 403 to a valid token whose label has no container in the config", async () => {
    expect(await status("/adapter/stream", { headers: bearer(TOKENS["ghost"] ?? "") })).toBe(403);
    expect(await post("/adapter/report", TOKENS["ghost"], REPORT)).toBe(403);
    expect(await post("/adapter/outcome", TOKENS["ghost"], "{}")).toBe(403);
    expect(await post("/adapter/inbox", TOKENS["ghost"], '{"session":"s"}')).toBe(403);
  });

  it("answers 403 to a report that names another product than the container's", async () => {
    expect(await post("/adapter/report", TOKENS["beta"], REPORT)).toBe(403);
    expect(await post("/adapter/report", TOKENS["alpha"], REPORT)).toBe(204);
  });

  it("answers 404 for other paths, 405 for the wrong method, and 400 for a bad body", async () => {
    expect(await status("/adapter/nothing", { headers: bearer(TOKENS["alpha"] ?? "") })).toBe(404);
    expect(await status("/adapter/report", { headers: bearer(TOKENS["alpha"] ?? "") })).toBe(405);
    expect(await post("/adapter/report", TOKENS["alpha"], "not json")).toBe(400);
    expect(await post("/adapter/report", TOKENS["alpha"], JSON.stringify({ product: "claude" }))).toBe(400);
    expect(await post("/adapter/report", TOKENS["alpha"], JSON.stringify({ ...JSON.parse(REPORT), extra: 1 }))).toBe(400);
  });

  it("refuses a body over 1 MiB with 413", async () => {
    const big = JSON.stringify({ product: "claude", pad: "x".repeat(1024 * 1024) });
    expect(await post("/adapter/report", TOKENS["alpha"], big)).toBe(413);
  });

  it("answers 204 to an outcome nobody is waiting for", async () => {
    const body = JSON.stringify({ id: "unknown", attempt: 1, result: { ok: true, certainty: "confirmed" } });
    expect(await post("/adapter/outcome", TOKENS["alpha"], body)).toBe(204);
  });

  it("answers /adapter/inbox with the texts waiting for the session, once, and 400 and 405 for a bad call", async () => {
    const beta = await fakeAdapter(h, "beta");
    await beta.post("/adapter/report", {
      product: "codex",
      capabilities: { push: false, wakesIdle: false, joinsTurn: false, certainty: "accepted" },
      sessions: [{ session: "pull-1", title: null, activity: "idle" }],
    });
    const alpha = await mcpClient(h, "alpha");
    const sent = await call(alpha, "send", { to_container: "beta", to_session: "pull-1", body: "pull me", session: "a1" });
    expect(sent.isError).toBe(false);
    const ask = (token: string | undefined, body: string): Promise<Response> =>
      fetch(adapterUrl(h, "/adapter/inbox"), { method: "POST", headers: { ...(token === undefined ? {} : bearer(token)), "content-type": "application/json" }, body });

    const res = await ask(TOKENS["beta"], '{"session":"pull-1"}');
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const answer = (await res.json()) as { messages: string[] };
    expect(answer.messages).toHaveLength(1);
    expect(answer.messages[0]).toContain("pull me");
    expect(answer.messages[0]).toContain('Container: "alpha" (verified by the gateway)');
    expect(await (await ask(TOKENS["beta"], '{"session":"pull-1"}')).json()).toEqual({ messages: [] });
    // Another container's token reaches only its own sessions.
    expect(await (await ask(TOKENS["alpha"], '{"session":"pull-1"}')).json()).toEqual({ messages: [] });

    for (const body of ["not json", "{}", '{"session":""}', '{"session":"s","extra":1}']) {
      const bad = await ask(TOKENS["beta"], body);
      await bad.arrayBuffer();
      expect(bad.status, body).toBe(400);
    }
    expect(await status("/adapter/inbox", { headers: bearer(TOKENS["beta"] ?? "") })).toBe(405);
    beta.close();
    await alpha.close();
  });

  it("replaces an open stream when the same container opens a second", async () => {
    const first = await fakeAdapter(h, "alpha");
    const second = await fakeAdapter(h, "alpha");
    await waitFor("the first stream to be closed", () => first.closed());
    expect(second.closed()).toBe(false);
    first.close();
    second.close();
  });

  it("pings an open stream", async () => {
    const adapter = await fakeAdapter(h, "beta");
    expect(pingEvery).toBeDefined();
    pingEvery?.();
    await waitFor("a ping", () => adapter.pings() > 0);
    adapter.close();
  });
});

describe("the MCP door", () => {
  it("refuses a call without a token or with a wrong one", async () => {
    await expect(mcpClient(h, "alpha", null)).rejects.toThrow();
    await expect(mcpClient(h, "alpha", "not-a-token-0123456789")).rejects.toThrow();
  });

  it("answers a token whose label is not in the config with a forbidden failure on every tool", async () => {
    const client = await mcpClient(h, "ghost");
    for (const [name, args] of [
      ["list_peers", {}],
      ["send", { to_container: "beta", to_session: "b1", body: "x", session: "g" }],
      ["inbox", { session: "g" }],
      ["reply", { message_id: "m", body: "x", session: "g" }],
    ] as const) {
      const answer = await call(client, name, args);
      expect(answer.isError, name).toBe(true);
      expect(JSON.stringify(answer.json), name).toContain("forbidden");
    }
    await client.close();
  });

  it("lists list_peers as a read and the others as writes", async () => {
    const client = await mcpClient(h, "alpha");
    const { tools } = await client.listTools();
    const access = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(access).toEqual({ list_peers: true, send: false, inbox: false, reply: false });
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(20);
    await client.close();
  });

  it("does not let a container read another container's session or answer its messages", async () => {
    const alpha = await mcpClient(h, "alpha");
    const beta = await mcpClient(h, "beta");
    const adapter = await fakeAdapter(h, "beta");
    await adapter.report("codex", [{ session: "b1", title: null, activity: "cold" }]);
    const sent = await call(alpha, "send", { to_container: "beta", to_session: "b1", body: "for beta", session: "a1" });
    expect(sent.isError).toBe(false);
    const stolen = await call(alpha, "inbox", { session: "b1" });
    expect(stolen.json["messages"]).toEqual([]);
    const forged = await call(alpha, "reply", { message_id: String(sent.json["id"]), body: "x", session: "b1" });
    expect(forged.isError).toBe(true);
    expect(JSON.stringify(forged.json)).toContain("not-found");
    const own = await call(beta, "inbox", { session: "b1" });
    expect((own.json["messages"] as unknown[]).length).toBe(1);
    adapter.close();
    await alpha.close();
    await beta.close();
  });
});

describe("an adapter whose stream closed", () => {
  it("is shown as offline after 90 seconds, pushed nothing, and back when it reconnects", async () => {
    const clock = { t: 1_000_000 };
    const offline = await startHarness({ policy: ALLOW_ALL, effects: { now: () => clock.t } });
    try {
      const a = await fakeAdapter(offline, "alpha");
      const b = await fakeAdapter(offline, "beta");
      await a.report("claude", [{ session: "a1", title: null, activity: "idle" }]);
      await b.report("codex", [{ session: "b1", title: null, activity: "idle" }]);
      const alpha = await mcpClient(offline, "alpha");
      const peersOf = async (): Promise<unknown> => {
        const peers = (await call(alpha, "list_peers", {})).json["peers"] as { container: string; session: string; activity: string; offline: boolean }[];
        return peers.filter((p) => p.container === "beta").map((p) => [p.session, p.activity, p.offline]);
      };
      expect(await peersOf()).toEqual([["b1", "idle", false]]);

      b.close();
      // The broker notices the close on its own time, so the clock moves on until it has: the close is stamped with the clock as it is then.
      await waitFor("the broker to see the stream close", () => {
        clock.t += 91_000;
        const peers = offline.running.service.listPeers("alpha");
        return Array.isArray(peers) && peers.some((p) => p.container === "beta" && p.offline);
      });
      expect(await peersOf()).toEqual([["b1", "unknown", true]]);

      const sent = await call(alpha, "send", { to_container: "beta", to_session: "b1", body: "while away", session: "a1" });
      expect(sent.isError).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(offline.running.store.get(String(sent.json["id"]))?.state).toBe("queued");

      const back = await fakeAdapter(offline, "beta");
      await waitFor("the message to go to the reconnected adapter", () => back.deliveries.length === 1);
      expect(await peersOf()).toEqual([["b1", "idle", false]]);
      back.close();
      a.close();
      await alpha.close();
    } finally {
      await offline.close();
    }
  });
});
