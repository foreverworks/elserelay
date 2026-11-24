import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { decide, gatewayTool, runIdentityHook, STDIN_TIMEOUT_MS } from "../src/hook/identity.js";
import type { IdentityProduct } from "../src/hook/identity.js";
import { ALLOW_ALL } from "./broker-fixtures.js";
import { call, fakeAdapter, mcpClient, startHarness } from "./http-rig.js";
import type { FakeAdapter, Harness } from "./http-rig.js";
import type { Client } from "@foreverworks/mcp-kit";

type Run = { readonly out: string[]; readonly code: number };

async function run(product: IdentityProduct, stdin: string | (() => Promise<string>), env: Record<string, string> = {}, timeoutMs?: number): Promise<Run> {
  const out: string[] = [];
  const code = await runIdentityHook(product, {
    env,
    readStdin: typeof stdin === "string" ? async () => stdin : stdin,
    out: (t) => out.push(t),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { out, code };
}

const call1 = (tool: string, input: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: "real-id", hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "t1", ...extra });

describe("hook claude and hook codex", () => {
  it("claude: puts the reported session id into the arguments and sets no permission decision", async () => {
    const r = await run("claude", call1("mcp__elserelay__send", { to_container: "b", to_session: "b1", body: "hi", session: "mistyped", title: "mine" }));
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(JSON.parse(r.out[0] ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { to_container: "b", to_session: "b1", body: "hi", session: "real-id", title: "mine" },
      },
    });
  });

  it("codex: the same, with an allow, because Codex applies updatedInput only with one", async () => {
    const r = await run("codex", call1("mcp__elserelay__reply", { message_id: "m1", body: "ok" }));
    expect(JSON.parse(r.out[0] ?? "")).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { message_id: "m1", body: "ok", session: "real-id" } },
    });
  });

  it("fills in a session the model left out, for inbox and for send, reply", async () => {
    for (const tool of ["send", "inbox", "reply"]) {
      const r = await run("claude", call1(`mcp__elserelay__${tool}`, {}));
      expect(JSON.parse(r.out[0] ?? "").hookSpecificOutput.updatedInput).toEqual({ session: "real-id" });
    }
  });

  it("does not change the arguments it was given or drop any of them", () => {
    const input = { to_container: "b", body: "x", session: "old", received: ["a"] };
    decide("claude", JSON.parse(call1("mcp__elserelay__inbox", input)), "elserelay");
    expect(input.session).toBe("old");
  });

  it("matches only this server's tools: ELSERELAY_HOOK_SERVER names the server, the default is elserelay", async () => {
    expect((await run("claude", call1("mcp__other__send", {}))).out).toEqual([]);
    expect((await run("claude", call1("mcp__elserelay__send", {}), { ELSERELAY_HOOK_SERVER: "other" })).out).toEqual([]);
    const named = await run("codex", call1("mcp__other__send", {}), { ELSERELAY_HOOK_SERVER: "other" });
    expect(JSON.parse(named.out[0] ?? "").hookSpecificOutput.updatedInput).toEqual({ session: "real-id" });
    // An empty setting is the default, not a server called "".
    expect((await run("claude", call1("mcp__elserelay__send", {}), { ELSERELAY_HOOK_SERVER: " " })).out).toHaveLength(1);
  });

  it("prints nothing for any other tool, in particular nothing that would allow it on Codex", async () => {
    const others = ["Bash", "Read", "mcp__elserelay__list_peers", "mcp__elserelay__other", "mcp__elserelay__", "mcp__elserelay__send_all", "mcp__gatewayx__send", "gateway__send", "send", "mcp__elserelay__send__x"];
    for (const tool of others) {
      for (const product of ["claude", "codex"] as const) expect((await run(product, call1(tool, { command: "ls" }))).out).toEqual([]);
    }
    expect((await run("codex", JSON.stringify({ session_id: "s", tool_input: {} }))).out).toEqual([]);
    expect((await run("codex", JSON.stringify({ session_id: "s", tool_name: 7, tool_input: {} }))).out).toEqual([]);
  });

  it("for our tools without a usable session id, prints nothing and exits 0", async () => {
    const bad: unknown[] = [undefined, null, "", "   ", 5, {}, "x".repeat(201)];
    for (const session_id of bad) {
      const text = JSON.stringify({ session_id, tool_name: "mcp__elserelay__send", tool_input: { session: "claimed" } });
      for (const product of ["claude", "codex"] as const) expect(await run(product, text)).toEqual({ out: [], code: 0 });
    }
  });

  it("trims the id, and refuses arguments that are not an object", async () => {
    const r = await run("claude", JSON.stringify({ session_id: "  real-id \n", tool_name: "mcp__elserelay__inbox", tool_input: {} }));
    expect(JSON.parse(r.out[0] ?? "").hookSpecificOutput.updatedInput.session).toBe("real-id");
    for (const tool_input of [undefined, null, "x", ["a"], 3]) {
      expect((await run("codex", JSON.stringify({ session_id: "s", tool_name: "mcp__elserelay__inbox", tool_input }))).out).toEqual([]);
    }
  });

  it("prints nothing and exits 0 for stdin that is empty, not JSON, JSON of another shape, or fails to read", async () => {
    for (const text of ["", "not json", "null", "[]", "7", '"mcp__elserelay__send"', "{"]) expect(await run("codex", text)).toEqual({ out: [], code: 0 });
    expect(await run("claude", async () => Promise.reject(new Error("closed")))).toEqual({ out: [], code: 0 });
  });

  it("does not wait for a stdin that never ends", async () => {
    const started = Date.now();
    const r = await run("claude", () => new Promise<string>(() => undefined), {}, 50);
    expect(r).toEqual({ out: [], code: 0 });
    expect(Date.now() - started).toBeLessThan(STDIN_TIMEOUT_MS);
  });

  it("gatewayTool names the tool, or null", () => {
    expect(gatewayTool("mcp__elserelay__send", "elserelay")).toBe("send");
    expect(gatewayTool("mcp__elserelay__list_peers", "elserelay")).toBeNull();
    expect(gatewayTool(undefined, "elserelay")).toBeNull();
  });
});

describe("the program's hook commands", () => {
  const cli = async (product: string, stdin: string, env: Record<string, string> = {}): Promise<{ out: string[]; err: string[]; code: number }> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["hook", product], env, { out: (l) => out.push(l), err: (l) => err.push(l), now: () => 0, stdin: async () => stdin });
    return { out, err, code };
  };

  it("runs hook claude and hook codex, one JSON line each, nothing on stderr", async () => {
    const claude = await cli("claude", call1("mcp__elserelay__send", {}));
    expect(claude.code).toBe(0);
    expect(claude.err).toEqual([]);
    expect(claude.out).toHaveLength(1);
    expect(JSON.parse(claude.out[0] ?? "").hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(JSON.parse((await cli("codex", call1("mcp__elserelay__send", {}))).out[0] ?? "").hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("prints nothing for another tool and for bad input, and reads no settings of the broker", async () => {
    expect(await cli("claude", call1("Bash", {}))).toEqual({ out: [], err: [], code: 0 });
    expect(await cli("codex", "not json")).toEqual({ out: [], err: [], code: 0 });
  });

  it("does not take the hook for claude or codex with extra words", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["hook", "claude", "extra"], {}, { out: (l) => out.push(l), err: (l) => err.push(l), now: () => 0, stdin: async () => call1("mcp__elserelay__send", {}) });
    expect(code).not.toBe(0);
    expect(out.join("\n")).not.toContain("updatedInput");
  });
});

describe("a call through the hook against a real broker", () => {
  const open: { h: Harness; a: FakeAdapter; alpha: Client }[] = [];
  afterEach(async () => {
    for (const r of open.splice(0)) {
      r.a.close();
      await r.alpha.close();
      await r.h.close();
    }
  });

  it("a send whose session the model mistyped is recorded under the session the product reported", async () => {
    const h = await startHarness({ policy: ALLOW_ALL });
    const a = await fakeAdapter(h, "alpha");
    const b = await fakeAdapter(h, "beta");
    await a.report("claude", [{ session: "real-id", title: null, activity: "idle" }]);
    await b.report("codex", [{ session: "b1", title: null, activity: "idle" }]);
    b.close();
    const alpha = await mcpClient(h, "alpha");
    open.push({ h, a, alpha });

    const asked = { to_container: "beta", to_session: "b1", body: "hello", session: "a-typo", title: "Alpha" };
    const hooked = await run("claude", call1("mcp__elserelay__send", asked));
    const updated = JSON.parse(hooked.out[0] ?? "").hookSpecificOutput.updatedInput as Record<string, unknown>;
    const sent = await call(alpha, "send", updated);
    expect(sent.isError).toBe(false);
    const stored = h.running.store.get(String(sent.json["id"]));
    expect(stored?.message.from).toMatchObject({ container: "alpha", session: "real-id" });
    expect(stored?.message.from.title).toBe("Alpha");
  });
});
