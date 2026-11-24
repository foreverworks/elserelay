import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { openStore } from "../src/store/sqlite.js";

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agw-cli-"));
  configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      store: join(dir, "broker.sqlite"),
      tokensDir: join(dir, "tokens"),
      listen: { mcpPort: 0, adapterPort: 0 },
      containers: { alpha: { product: "claude" } },
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function io(now = Date.parse("2026-11-24T09:30:00Z")) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), now: () => now } };
}

const stoppedNow = (): boolean => {
  const store = openStore(join(dir, "broker.sqlite"));
  try {
    return store.stopped();
  } finally {
    store.close();
  }
};

describe("agent-gateway", () => {
  it("stops and starts, leaving a line with the time on stderr", async () => {
    const stop = io();
    expect(await runCli(["stop", "--config", configPath], {}, stop.io)).toBe(0);
    expect(stop.err).toEqual(["2026-11-24T09:30:00.000Z stopped: deliveries are held and new messages are refused"]);
    expect(stoppedNow()).toBe(true);
    const start = io(Date.parse("2026-11-24T10:00:00Z"));
    expect(await runCli(["start", "--config", configPath], {}, start.io)).toBe(0);
    expect(start.err).toEqual(["2026-11-24T10:00:00.000Z started: deliveries resume"]);
    expect(stoppedNow()).toBe(false);
  });

  it("takes the config path from the environment", async () => {
    const run = io();
    expect(await runCli(["approvals"], { AGENT_GATEWAY_CONFIG: configPath }, run.io)).toBe(0);
    expect(run.out).toEqual(["nothing is waiting"]);
  });

  it("answers a missing id or command with the usage and a failing code", async () => {
    const run = io();
    expect(await runCli(["approve", "--config", configPath], {}, run.io)).toBe(2);
    expect(await runCli([], {}, run.io)).toBe(2);
    expect(await runCli(["approvals"], {}, run.io)).toBe(2);
    expect(await runCli(["nonsense", "--config", configPath], {}, run.io)).toBe(2);
    expect(run.err.join("\n")).toContain("usage: agent-gateway");
  });

  it("says so when a message is unknown, and rejects a bad time for audit", async () => {
    const run = io();
    expect(await runCli(["approve", "nope", "--config", configPath], {}, run.io)).toBe(1);
    expect(run.err).toContain("no message nope");
    expect(await runCli(["audit", "--since", "yesterday-ish", "--config", configPath], {}, run.io)).toBe(2);
  });

  it("reports a broken config file instead of running", async () => {
    writeFileSync(configPath, "{}");
    const run = io();
    expect(await runCli(["approvals", "--config", configPath], {}, run.io)).toBe(1);
    expect(run.err.join("\n")).toContain("has problems");
  });
});
