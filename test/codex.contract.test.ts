/**
 * Against the real app-server, with no login: a private CODEX_HOME, an explicit
 * socket path, and nothing that needs the model. Runs only when CODEX_BIN names
 * the codex binary.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexDriver, connectUnix } from "../src/drivers/codex.js";
import { createConnection } from "../src/drivers/codex/connection.js";
import { isUnknownThreadMessage, threadListSchema, threadLoadedListSchema } from "../src/drivers/codex/wire.js";

const bin = process.env["CODEX_BIN"];
const UNKNOWN = "01a20e02-9907-7ef2-adae-4a2cc98c5a0b";

describe.skipIf(bin === undefined)("the real codex app-server", () => {
  let dir = "";
  let child: ChildProcess | undefined;
  let socket = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "agw-codex-real-"));
    socket = join(dir, "app-server.sock");
    await mkdir(join(dir, "home"));
    child = spawn(bin ?? "", ["app-server", "--listen", `unix://${socket}`], {
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, CODEX_HOME: join(dir, "home") },
      stdio: "ignore",
    });
    const connect = connectUnix(socket);
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        (await connect({ message: () => {}, close: () => {} })).close();
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  const open = () => createConnection({ connect: connectUnix(socket), timeoutMs: 10_000, clientInfo: { name: "agw-contract-test", title: null, version: "0.0.0" } });

  it("answers initialize, once", async () => {
    const connection = open();
    // The first call opens the connection, which sends initialize and then initialized.
    expect((await connection.call("thread/loaded/list", {})).ok).toBe(true);
    const again = await connection.call("initialize", { clientInfo: { name: "x", title: null, version: "0" }, capabilities: null });
    expect(again).toMatchObject({ ok: false, failure: { kind: "rpc", message: "Already initialized" } });
    connection.close();
  });

  it("lists threads and loaded threads in the shapes the driver reads", async () => {
    const connection = open();
    const listed = await connection.call("thread/list", { limit: 50, sortKey: "updated_at", sortDirection: "desc" });
    const loaded = await connection.call("thread/loaded/list", {});
    expect(listed.ok && threadListSchema.safeParse(listed.result).success).toBe(true);
    expect(loaded.ok && threadLoadedListSchema.safeParse(loaded.result).success).toBe(true);
    connection.close();
  });

  it("says an unknown thread is unknown, in words the driver recognises", async () => {
    const connection = open();
    const read = await connection.call("thread/read", { threadId: UNKNOWN, includeTurns: false });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.failure.kind === "rpc" && isUnknownThreadMessage(read.failure.message)).toBe(true);
    connection.close();
  });

  it("works through the driver with no login", async () => {
    const driver = createCodexDriver({ connect: connectUnix(socket) });
    expect(await driver.list()).toEqual([]);
    expect(await driver.status(UNKNOWN)).toBeNull();
    expect(await driver.deliver(UNKNOWN, "hello")).toMatchObject({ ok: false, retry: false });
  });
});
