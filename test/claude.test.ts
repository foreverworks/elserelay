import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeDriver, nodeClaudeEnv } from "../src/drivers/claude.js";
import type { ClaudeEnv } from "../src/drivers/claude.js";

const NOW = 1_800_000_000_000;

type Rig = {
  readonly dir: string;
  readonly sockets: string;
  readonly received: string[];
  readonly read: string[];
  readonly dead: Set<number>;
  readonly env: ClaudeEnv;
  readonly record: (pid: number, extra?: Record<string, unknown>) => Promise<string>;
  readonly listen: (socketName: string, onConnection?: (s: Socket) => void) => Promise<void>;
};

const servers: Server[] = [];

async function rig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "agw-claude-"));
  const dir = join(root, "sessions");
  const sockets = join(root, "socks");
  await mkdir(dir);
  await mkdir(sockets);
  const received: string[] = [];
  const read: string[] = [];
  const dead = new Set<number>();
  const base = nodeClaudeEnv(dir);
  const env: ClaudeEnv = {
    ...base,
    now: () => NOW,
    pidAlive: (pid) => !dead.has(pid),
    readFile: async (p) => {
      read.push(p);
      return base.readFile(p);
    },
  };
  return {
    dir,
    sockets,
    received,
    read,
    dead,
    env,
    record: async (pid, extra = {}) => {
      const sessionId = `sess-${pid}`;
      await writeFile(
        join(dir, `${pid}.json`),
        JSON.stringify({
          pid,
          sessionId,
          name: `name-${pid}`,
          status: "idle",
          statusUpdatedAt: NOW - 1000,
          messagingSocketPath: join(sockets, `${pid}.sock`),
          peerProtocol: 1,
          ...extra,
        }),
      );
      return sessionId;
    },
    listen: async (name, onConnection) => {
      const server = createServer((s) => {
        s.on("data", (d) => received.push(d.toString("utf8")));
        s.on("error", () => undefined);
        onConnection?.(s);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(join(sockets, name), resolve));
    },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

let r: Rig;
beforeEach(async () => {
  r = await rig();
});

describe("claude driver: list", () => {
  it("lists a live session with its id, title and activity", async () => {
    await r.listen("10.sock");
    await r.record(10);
    expect(await createClaudeDriver(r.env).list()).toEqual([{ session: "sess-10", title: "name-10", activity: "idle" }]);
  });

  it("maps busy, cold and unknown", async () => {
    for (const pid of [11, 12, 13, 14]) await r.listen(`${pid}.sock`);
    await r.record(11, { status: "busy" });
    await r.record(12, { status: "idle", statusUpdatedAt: NOW - 3_600_001 });
    await r.record(13, { status: "waiting" });
    await r.record(14, { status: "idle", statusUpdatedAt: NOW - 3_600_000 });
    const list = await createClaudeDriver(r.env).list();
    const by = Object.fromEntries(list.map((s) => [s.session, s.activity]));
    expect(by).toEqual({ "sess-11": "busy", "sess-12": "cold", "sess-13": "unknown", "sess-14": "idle" });
  });

  it("gives a null title when the record has no name", async () => {
    await r.listen("15.sock");
    await r.record(15, { name: undefined });
    expect((await createClaudeDriver(r.env).list())[0]?.title).toBeNull();
  });

  it("skips records that do not parse, a dead pid and a missing socket", async () => {
    await r.listen("20.sock");
    await r.listen("21.sock");
    await r.record(20);
    await r.record(21);
    r.dead.add(21);
    await r.record(22); // no socket
    await writeFile(join(r.dir, "23.json"), "{not json");
    await writeFile(join(r.dir, "24.json"), JSON.stringify({ pid: "x", sessionId: 5 }));
    await writeFile(join(r.dir, "25.json"), JSON.stringify([]));
    const list = await createClaudeDriver(r.env).list();
    expect(list.map((s) => s.session)).toEqual(["sess-20"]);
  });

  it("is empty when the directory is missing", async () => {
    const env = { ...r.env, dir: join(r.dir, "absent") };
    expect(await createClaudeDriver(env).list()).toEqual([]);
  });

  it("never reads a key file", async () => {
    await r.listen("30.sock");
    await r.record(30);
    await writeFile(join(r.dir, "30.deadbeef.key"), "secret");
    await createClaudeDriver(r.env).list();
    expect(r.read.some((p) => p.endsWith(".key"))).toBe(false);
    expect(r.read.length).toBeGreaterThan(0);
  });

  it("answers status for a session and null for another", async () => {
    await r.listen("40.sock");
    await r.record(40);
    const d = createClaudeDriver(r.env);
    expect(await d.status("sess-40")).toEqual({ session: "sess-40", title: "name-40", activity: "idle" });
    expect(await d.status("other")).toBeNull();
  });
});

describe("claude driver: deliver", () => {
  it("writes the one JSON line and answers accepted", async () => {
    await r.listen("50.sock");
    const id = await r.record(50);
    const result = await createClaudeDriver(r.env).deliver(id, "hello\nthere");
    expect(result).toEqual({ ok: true, certainty: "accepted" });
    expect(r.received.join("")).toBe(
      `${JSON.stringify({ type: "user", message: { role: "user", content: "hello\nthere" }, from: "agent-gateway" })}\n`,
    );
    expect(r.received.join("").split("\n")).toHaveLength(2);
  });

  it("answers a missing session with retry false", async () => {
    const result = await createClaudeDriver(r.env).deliver("nope", "x");
    expect(result).toMatchObject({ ok: false, retry: false });
  });

  it("answers a dead process with retry false", async () => {
    await r.listen("51.sock");
    const id = await r.record(51);
    r.dead.add(51);
    expect(await createClaudeDriver(r.env).deliver(id, "x")).toMatchObject({ ok: false, retry: false });
    expect(r.received).toEqual([]);
  });

  it("answers a connect error with retry true", async () => {
    const id = await r.record(52);
    // The socket exists as far as the driver can tell, but nothing listens.
    const env: ClaudeEnv = { ...r.env, isSocket: async () => true };
    const result = await createClaudeDriver(env).deliver(id, "x");
    expect(result).toMatchObject({ ok: false, retry: true });
  });

  it("answers a close within the wait, after the line was written, with retry false and an unknown outcome", async () => {
    await r.listen("53.sock", (s) => s.destroy());
    const id = await r.record(53);
    const result = await createClaudeDriver(r.env).deliver(id, "x");
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(result.ok ? "" : result.detail).toContain("outcome unknown");
  });

  it("answers a socket that reads the line and then fails with retry false, but one that never connected with retry true", async () => {
    const got: string[] = [];
    await r.listen("56.sock", (s) => {
      s.once("data", (d: Buffer) => {
        got.push(d.toString("utf8"));
        s.destroy(new Error("reset"));
      });
    });
    const id = await r.record(56);
    const after = await createClaudeDriver(r.env).deliver(id, "x");
    expect(got).toHaveLength(1);
    expect(after).toMatchObject({ ok: false, retry: false });

    const none = await r.record(57);
    const before = await createClaudeDriver({ ...r.env, isSocket: async () => true }).deliver(none, "x");
    expect(before).toMatchObject({ ok: false, retry: true });
  });

  it("refuses another peer protocol, with retry false and a clear detail, without connecting", async () => {
    await r.listen("54.sock");
    const id = await r.record(54, { peerProtocol: 2 });
    const none = await r.record(55, { peerProtocol: undefined });
    await r.listen("55.sock");
    const d = createClaudeDriver(r.env);
    const result = await d.deliver(id, "x");
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(result.ok ? "" : result.detail).toContain("peer protocol 2");
    expect(await d.deliver(none, "x")).toMatchObject({ ok: false, retry: false });
    expect(r.received).toEqual([]);
  });
});
