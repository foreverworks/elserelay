import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Runs dist/elserelay.mjs as a program, with the Node that runs this test and with only the environment given,
 * the way a machine beside an agent runs it. `npm run bundle` comes first; `npm run smoke` runs this.
 */
const bundle = resolve("dist/elserelay.mjs");

type Result = { readonly code: number | null; readonly out: string; readonly err: string };

function run(args: readonly string[], env: Record<string, string>, stdin?: string): Promise<Result> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bundle, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", fail);
    child.on("close", (code) => done({ code, out, err }));
    child.stdin.end(stdin);
  });
}

describe(`dist/elserelay.mjs on Node ${process.versions.node}`, () => {
  it("is there", () => {
    expect(existsSync(bundle)).toBe(true);
  });

  it("prints its usage, and exits 2 for no command", async () => {
    const r = await run([], {});
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^usage: elserelay <command>/);
    expect(r.err).toContain("broker");
    expect(r.out).toBe("");
  });

  it("health against a closed port says unhealthy and exits 1", async () => {
    const r = await run(["health", "http://127.0.0.1:9/healthz"], {});
    expect(r.code).toBe(1);
    expect(r.err).toContain("unhealthy");
  });

  it("hook claude puts the reported session id into the call, and says nothing on stderr", async () => {
    const stdin = JSON.stringify({ session_id: "real-id", hook_event_name: "PreToolUse", tool_name: "mcp__elserelay__inbox", tool_input: {}, tool_use_id: "t1" });
    const r = await run(["hook", "claude"], {}, stdin);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { session: "real-id" } } });
    // A warning on stderr (Node 22 prints one when SQLite is loaded) would reach the agent on every model call.
    expect(r.err).toBe("");
  });

  it("an adapter with bad settings fails cleanly: one line, exit 2", async () => {
    const r = await run(["adapter"], { ELSERELAY_PRODUCT: "bogus" });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^elserelay adapter: bad settings: /);
    expect(r.err.trim().split("\n")).toHaveLength(1);
  });

  it("an adapter whose token file is missing fails cleanly too", async () => {
    const r = await run(["adapter"], {
      ELSERELAY_URL: "http://127.0.0.1:9",
      ELSERELAY_TOKEN_FILE: "/nonexistent/token",
      ELSERELAY_PRODUCT: "fake",
      ELSERELAY_STATE_DIR: "/nonexistent/state",
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("cannot read the token file");
  });
});
