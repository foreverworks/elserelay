import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyDedupe, loadDedupe, nodeDedupeIo, remember } from "../src/adapter/dedupe.js";
import { run } from "../src/adapter/run.js";
import type { RunDeps, RunEnd, Timing } from "../src/adapter/run.js";
import { emptyFake, makeFake } from "../src/drivers/fake.js";
import type { Outcome, AdapterReport, ToAdapter } from "../src/wire.js";

const TOKEN = "test-token-value";

const fast: Timing = { deadMs: 2000, reportEveryMs: 30_000, pollMs: 20, backoffBaseMs: 5, backoffMaxMs: 20, postAttempts: 4 };

const sleep = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(false); }, { once: true });
  });

type Broker = {
  url: string;
  readonly reports: AdapterReport[];
  readonly outcomes: Outcome[];
  readonly auths: (string | undefined)[];
  streams: number;
  /** Frames to send to the current and later streams. */
  readonly send: (event: ToAdapter | string) => void;
  readonly closeStreams: () => void;
  readonly mode: { stream: number; outcomeFailures: number; outcomeStatus: number };
};

const servers: Server[] = [];
const sockets = new Set<ServerResponse>();

async function broker(): Promise<Broker> {
  const b: Broker = {
    url: "",
    reports: [],
    outcomes: [],
    auths: [],
    streams: 0,
    send: (e) => {
      const frame = typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`;
      for (const s of sockets) s.write(frame);
    },
    closeStreams: () => {
      for (const s of [...sockets]) s.end();
    },
    mode: { stream: 200, outcomeFailures: 0, outcomeStatus: 500 },
  };
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let t = "";
      req.on("data", (d: Buffer) => (t += d.toString("utf8")));
      req.on("end", () => resolve(t));
    });
  const server = createServer((req, res) => {
    b.auths.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && req.url === "/adapter/stream") {
      b.streams++;
      if (b.mode.stream !== 200) {
        res.writeHead(b.mode.stream).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": hello\n\n");
      sockets.add(res);
      res.on("close", () => sockets.delete(res));
      return;
    }
    void readBody(req).then((text) => {
      if (req.url === "/adapter/report") b.reports.push(JSON.parse(text) as AdapterReport);
      if (req.url === "/adapter/outcome") {
        if (b.mode.outcomeFailures > 0) {
          b.mode.outcomeFailures--;
          res.writeHead(b.mode.outcomeStatus).end();
          return;
        }
        b.outcomes.push(JSON.parse(text) as Outcome);
      }
      res.writeHead(204).end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  b.url = `http://127.0.0.1:${addr.port}`;
  return b;
}

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const until = async (cond: () => boolean, what: string, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const s1 = { session: "s1", title: "one", activity: "idle" } as const;
const s2 = { session: "s2", title: "two", activity: "busy" } as const;

const deliver = (id: string, session: string, text = `text ${id}`, attempt = 1): ToAdapter => ({
  kind: "deliver",
  id,
  attempt,
  to: { container: "c", product: "fake", session },
  text,
});

type Started = {
  readonly b: Broker;
  readonly dir: string;
  readonly path: string;
  readonly stop: () => Promise<RunEnd>;
  readonly done: Promise<RunEnd>;
};

async function start(
  b: Broker,
  fake: ReturnType<typeof makeFake>,
  over: Partial<RunDeps> = {},
  dir?: string,
): Promise<Started> {
  const d = dir ?? (await mkdtemp(join(tmpdir(), "agw-run-")));
  const path = join(d, "delivered.json");
  const ctl = new AbortController();
  const logs: string[] = [];
  const deps: RunDeps = {
    url: b.url,
    token: TOKEN,
    driver: fake.driver,
    dedupePath: path,
    dedupeIo: nodeDedupeIo,
    fetch,
    sleep,
    now: Date.now,
    random: () => 0.5,
    log: (l) => logs.push(l),
    timing: fast,
    ...over,
  };
  const done = run(deps, ctl.signal);
  return { b, dir: d, path, done, stop: () => (ctl.abort(), done) };
}

describe("run", () => {
  it("opens the stream with the bearer token and posts a report on connect", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1, s2] });
    const s = await start(b, fake);
    await until(() => b.reports.length > 0, "report");
    expect(b.reports[0]).toEqual({
      product: "fake",
      capabilities: { push: true, wakesIdle: true, joinsTurn: true, certainty: "confirmed" },
      sessions: [s1, s2],
    });
    expect(b.auths.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    expect(await s.stop()).toEqual({ reason: "stopped" });
  });

  it("keeps the last report when the driver cannot list, and logs the same failure once", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    let broken = false;
    const driver = { ...fake.driver, list: async () => { if (broken) throw new Error("app-server unreachable"); return fake.driver.list(); } };
    const logs: string[] = [];
    const s = await start(b, fake, { driver, log: (l) => logs.push(l) });
    await until(() => b.reports.length === 1, "first report");
    broken = true;
    await new Promise((r) => setTimeout(r, 150));
    expect(b.reports).toHaveLength(1);
    expect(logs.filter((l) => l.includes("could not list sessions"))).toEqual(["could not list sessions: app-server unreachable"]);
    broken = false;
    fake.update((st) => ({ ...st, sessions: [s1, s2] }));
    await until(() => b.reports.length === 2, "report after recovery");
    expect(b.reports[1]?.sessions).toEqual([s1, s2]);
    broken = true;
    await until(() => logs.filter((l) => l.includes("could not list sessions")).length === 2, "a second log line after recovery");
    await s.stop();
  });

  it("posts the report again when the list changes, and only then", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake);
    await until(() => b.reports.length === 1, "first report");
    await new Promise((r) => setTimeout(r, 120));
    expect(b.reports).toHaveLength(1);
    fake.update((st) => ({ ...st, sessions: [s1, s2] }));
    await until(() => b.reports.length === 2, "second report");
    expect(b.reports[1]?.sessions).toEqual([s1, s2]);
    await s.stop();
  });

  it("posts the report on its schedule even when nothing changed", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake, { timing: { ...fast, reportEveryMs: 60 } });
    await until(() => b.reports.length >= 3, "three reports");
    await s.stop();
  });

  it("delivers a message, posts the outcome and remembers the id on disk", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake);
    await until(() => b.streams === 1 && b.reports.length > 0, "connected");
    b.send(deliver("m1", "s1", "hello", 3));
    await until(() => b.outcomes.length === 1, "outcome");
    expect(b.outcomes[0]).toEqual({ id: "m1", attempt: 3, result: { ok: true, certainty: "confirmed" } });
    expect(fake.read().delivered).toEqual([{ session: "s1", text: "hello" }]);
    const saved = await loadDedupe(nodeDedupeIo, s.path);
    expect(saved.entries.map((e) => e.id)).toEqual(["m1"]);
    await s.stop();
  });

  it("answers a known id with the remembered outcome and does not deliver again", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake);
    await until(() => b.reports.length > 0, "connected");
    b.send(deliver("m1", "s1"));
    await until(() => b.outcomes.length === 1, "first outcome");
    b.send(deliver("m1", "s1", "text m1", 2));
    await until(() => b.outcomes.length === 2, "second outcome");
    expect(b.outcomes[1]).toEqual({ id: "m1", attempt: 2, result: { ok: true, certainty: "confirmed" } });
    expect(fake.read().delivered).toHaveLength(1);
    await s.stop();
  });

  it("does not deliver twice after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agw-run-"));
    await nodeDedupeIo.write(join(dir, "delivered.json"), JSON.stringify({ version: 1, entries: [{ id: "m1", certainty: "accepted" }] }));
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake, {}, dir);
    await until(() => b.reports.length > 0, "connected");
    b.send(deliver("m1", "s1"));
    await until(() => b.outcomes.length === 1, "outcome");
    expect(b.outcomes[0]?.result).toEqual({ ok: true, certainty: "accepted" });
    expect(fake.read().delivered).toEqual([]);
    await s.stop();
  });

  it("writes the id down before it posts the outcome", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const dir = await mkdtemp(join(tmpdir(), "agw-run-"));
    const events: string[] = [];
    const s = await start(b, fake, {
      dedupeIo: {
        read: nodeDedupeIo.read,
        write: async (p, t) => {
          events.push("saved");
          await nodeDedupeIo.write(p, t);
        },
      },
      fetch: async (input, init) => {
        if (String(input).endsWith("/adapter/outcome")) events.push("posted");
        return fetch(input, init);
      },
    }, dir);
    await until(() => b.reports.length > 0, "connected");
    b.send(deliver("m1", "s1"));
    await until(() => b.outcomes.length === 1, "outcome");
    expect(events).toEqual(["saved", "posted"]);
    await s.stop();
  });

  it("does not remember a failed delivery, so a retry is delivered", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1], refusals: { s1: { ok: false, retry: true, detail: "later" } } });
    const s = await start(b, fake);
    await until(() => b.reports.length > 0, "connected");
    b.send(deliver("m1", "s1"));
    await until(() => b.outcomes.length === 1, "failure outcome");
    expect(b.outcomes[0]?.result).toEqual({ ok: false, retry: true, detail: "later" });
    fake.update((st) => ({ ...st, refusals: {} }));
    b.send(deliver("m1", "s1", "text m1", 2));
    await until(() => b.outcomes.length === 2, "success outcome");
    expect(b.outcomes[1]?.result.ok).toBe(true);
    expect(fake.read().delivered).toHaveLength(1);
    await s.stop();
  });

  it("turns a throwing driver into a failed outcome", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const driver = { ...fake.driver, deliver: async () => { throw new Error("boom"); } };
    const s = await start(b, fake, { driver });
    await until(() => b.reports.length > 0, "connected");
    b.send(deliver("m1", "s1"));
    await until(() => b.outcomes.length === 1, "outcome");
    expect(b.outcomes[0]?.result).toEqual({ ok: false, retry: true, detail: "driver error: boom" });
    await s.stop();
  });

  it("retries a post that fails", async () => {
    const b = await broker();
    b.mode.outcomeFailures = 2;
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake);
    await until(() => b.reports.length > 0, "connected");
    b.send(deliver("m1", "s1"));
    await until(() => b.outcomes.length === 1, "outcome after retries");
    expect(fake.read().delivered).toHaveLength(1);
    await s.stop();
  });

  it("does not retry a post the broker refuses for good", async () => {
    const b = await broker();
    b.mode.outcomeFailures = 10;
    b.mode.outcomeStatus = 400;
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake);
    await until(() => b.reports.length > 0, "connected");
    b.send(deliver("m1", "s1"));
    await until(() => b.mode.outcomeFailures === 9, "one post");
    await new Promise((r) => setTimeout(r, 100));
    expect(b.mode.outcomeFailures).toBe(9);
    await s.stop();
  });

  it("delivers one at a time per session and sessions in parallel", async () => {
    const b = await broker();
    const gates = new Map<string, () => void>();
    const active: string[] = [];
    let maxOnS1 = 0;
    const fake = makeFake({ ...emptyFake, sessions: [s1, s2] }, async (session, text) => {
      active.push(`${session}:${text}`);
      maxOnS1 = Math.max(maxOnS1, active.filter((a) => a.startsWith("s1:")).length);
      await new Promise<void>((resolve) => gates.set(text, resolve));
      active.splice(active.indexOf(`${session}:${text}`), 1);
    });
    const s = await start(b, fake);
    await until(() => b.reports.length > 0, "connected");
    b.send(deliver("a", "s1", "a"));
    b.send(deliver("b", "s1", "b"));
    b.send(deliver("c", "s2", "c"));
    await until(() => gates.has("a") && gates.has("c"), "a and c running");
    expect(gates.has("b")).toBe(false);
    gates.get("a")?.();
    await until(() => gates.has("b"), "b running after a");
    gates.get("b")?.();
    gates.get("c")?.();
    await until(() => b.outcomes.length === 3, "three outcomes");
    expect(maxOnS1).toBe(1);
    await s.stop();
  });

  it("reconnects with backoff after the stream ends and reports again", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake);
    await until(() => b.streams === 1 && b.reports.length === 1, "first connection");
    b.closeStreams();
    await until(() => b.streams === 2 && b.reports.length === 2, "second connection");
    await s.stop();
  });

  it("backs off and retries when the broker answers an error", async () => {
    const b = await broker();
    b.mode.stream = 503;
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake);
    await until(() => b.streams >= 3, "three tries");
    b.mode.stream = 200;
    await until(() => b.reports.length > 0, "report after recovery");
    await s.stop();
  });

  it("treats a silent stream as dead and reconnects", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake, { timing: { ...fast, deadMs: 80 } });
    await until(() => b.streams >= 2, "reconnect after silence");
    await s.stop();
  });

  it("stays connected while data keeps arriving", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake, { timing: { ...fast, deadMs: 100 } });
    await until(() => b.streams === 1, "connected");
    for (let i = 0; i < 6; i++) {
      b.send({ kind: "ping" });
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(b.streams).toBe(1);
    await s.stop();
  });

  it("stops the process on a 401 with a message that does not hold the token", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake, { token: "tok-xyz-secret" });
    const end = await s.done;
    expect(end.reason).toBe("unauthorized");
    if (end.reason === "unauthorized") {
      expect(end.message).toContain("401");
      expect(end.message).not.toContain("tok-xyz-secret");
    }
    expect(b.streams).toBe(0);
  });

  it("logs nothing that holds the token", async () => {
    const b = await broker();
    b.mode.stream = 500;
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const logs: string[] = [];
    const s = await start(b, fake, { log: (l) => logs.push(l) });
    await until(() => logs.length > 0, "a log line");
    await s.stop();
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("stops cleanly on the abort signal, also while connecting", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake);
    expect(await s.stop()).toEqual({ reason: "stopped" });
    const again = new AbortController();
    again.abort();
    const dir = await mkdtemp(join(tmpdir(), "agw-run-"));
    const end = await run(
      { url: b.url, token: TOKEN, driver: fake.driver, dedupePath: join(dir, "d.json"), dedupeIo: nodeDedupeIo, fetch, sleep, now: Date.now, random: () => 0, log: () => undefined, timing: fast },
      again.signal,
    );
    expect(end).toEqual({ reason: "stopped" });
  });

  it("bounds the memory it keeps on disk", async () => {
    const b = await broker();
    const fake = makeFake({ ...emptyFake, sessions: [s1] });
    const s = await start(b, fake, { dedupeLimit: 2 });
    await until(() => b.reports.length > 0, "connected");
    for (const id of ["a", "b", "c"]) {
      b.send(deliver(id, "s1"));
      await until(() => b.outcomes.some((o) => o.id === id), `outcome ${id}`);
    }
    await s.stop();
    expect((await loadDedupe(nodeDedupeIo, s.path, 2)).entries.map((e) => e.id)).toEqual(["b", "c"]);
    expect(remember(emptyDedupe, "x", { ok: true, certainty: "accepted" }).entries).toHaveLength(1);
  });
});
