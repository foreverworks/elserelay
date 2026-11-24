import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, runAntigravityHook } from "../src/hook/antigravity.js";
import type { HookDeps } from "../src/hook/antigravity.js";
import { ALLOW_ALL } from "./broker-fixtures.js";
import { fakeAdapter, startHarness, TOKENS } from "./http-rig.js";
import type { FakeAdapter, Harness } from "./http-rig.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Run = { readonly out: string[]; readonly err: string[]; readonly code: number };

async function hook(over: Partial<HookDeps> & { readonly stdin?: string }): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const { stdin, ...deps } = over;
  const code = await runAntigravityHook({
    env: { ELSERELAY_URL: "http://127.0.0.1:9", ELSERELAY_TOKEN_FILE: "/token" },
    readStdin: async () => stdin ?? JSON.stringify({ conversationId: "conv-1" }),
    readFile: async () => "secret-token\n",
    fetch,
    out: (t) => out.push(t),
    err: (l) => err.push(l),
    ...deps,
  });
  return { out, err, code };
}

/** A broker stand-in that answers `/adapter/inbox` as the test says. */
type Stub = { readonly url: string; readonly seen: { auth: string | undefined; body: string }[]; readonly close: () => Promise<void> };
const stubs: Stub[] = [];
async function stub(answer: (respond: (status: number, body: string) => void, req: { auth: string | undefined; body: string }) => void): Promise<Stub> {
  const seen: Stub["seen"] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString("utf8")));
    req.on("end", () => {
      const entry = { auth: req.headers.authorization, body };
      seen.push(entry);
      answer((status, text) => res.writeHead(status, { "content-type": "application/json" }).end(text), entry);
    });
  });
  server.on("connection", (s) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const s: Stub = {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise<void>((r) => { for (const x of sockets) x.destroy(); server.close(() => r()); }),
  };
  stubs.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});

// A product that cannot be pushed to, as Antigravity reports itself: the broker leaves its messages in the inbox.
const pullOnly = (a: FakeAdapter, session: string): Promise<number> =>
  a.post("/adapter/report", {
    product: "claude",
    capabilities: { push: false, wakesIdle: false, joinsTurn: false, certainty: "accepted" },
    sessions: [{ session, title: null, activity: "idle" }],
  });

const withUrl = (url: string): Partial<HookDeps> => ({ env: { ELSERELAY_URL: url, ELSERELAY_TOKEN_FILE: "/token" } });

describe("the Antigravity hook", () => {
  it("posts the conversation id with the token and prints each waiting message as an injected user message", async () => {
    const s = await stub((respond) => respond(200, JSON.stringify({ messages: [{ id: "m1", text: "first" }, { id: "m2", text: "second \"quoted\"\nline" }] })));
    const run = await hook(withUrl(s.url));
    expect(run.code).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out).toHaveLength(1);
    expect(JSON.parse(run.out[0] ?? "")).toEqual({ injectSteps: [{ userMessage: "first" }, { userMessage: "second \"quoted\"\nline" }] });
    expect(s.seen).toEqual([
      { auth: "Bearer secret-token", body: JSON.stringify({ session: "conv-1" }) },
      { auth: "Bearer secret-token", body: JSON.stringify({ session: "conv-1", received: ["m1", "m2"], acknowledgeOnly: true }) },
    ]);
  });

  it("writes its output before it acknowledges, and ignores a failed acknowledgement", async () => {
    const s = await stub((respond, req) => (req.body.includes("acknowledgeOnly") ? respond(500, "no") : respond(200, JSON.stringify({ messages: [{ id: "m1", text: "x" }] }))));
    const written: string[] = [];
    const seenWhenWritten: number[] = [];
    const run = await hook({ ...withUrl(s.url), out: (t) => { seenWhenWritten.push(s.seen.length); written.push(t); } });
    expect(seenWhenWritten).toEqual([1]);
    expect(s.seen).toHaveLength(2);
    expect(run).toMatchObject({ code: 0, err: [] });
    expect(written).toHaveLength(1);
  });

  it("does not acknowledge when nothing was handed out", async () => {
    const s = await stub((respond) => respond(200, JSON.stringify({ messages: [] })));
    await hook(withUrl(s.url));
    expect(s.seen).toHaveLength(1);
  });

  it("prints nothing when nothing waits", async () => {
    const s = await stub((respond) => respond(200, JSON.stringify({ messages: [] })));
    const run = await hook(withUrl(s.url));
    expect(run).toEqual({ out: [], err: [], code: 0 });
  });

  it("ignores the rest of the hook's input", async () => {
    const s = await stub((respond) => respond(200, '{"messages":[{"id":"m1","text":"x"}]}'));
    const run = await hook({ ...withUrl(s.url), stdin: JSON.stringify({ conversationId: "c9", workspacePaths: ["/w"], invocationNum: 3, lastUserInput: "hi" }) });
    expect(run.out).toHaveLength(1);
    expect(s.seen[0]?.body).toBe(JSON.stringify({ session: "c9" }));
  });

  it("prints nothing and exits 0 when the broker is not there", async () => {
    const s = await stub(() => undefined);
    const url = s.url;
    await s.close();
    const run = await hook(withUrl(url));
    expect(run.out).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.err).toHaveLength(1);
  });

  it("gives up on a slow broker within its time", async () => {
    const s = await stub(() => undefined);
    const started = Date.now();
    const run = await hook({ ...withUrl(s.url), timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(run).toMatchObject({ out: [], code: 0 });
    expect(HOOK_TIMEOUT_MS).toBe(3000);
  });

  it("gives up on a stdin that never ends", async () => {
    const started = Date.now();
    const run = await hook({ readStdin: () => new Promise<string>(() => undefined), timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(run).toMatchObject({ out: [], code: 0 });
  });

  it("gives up on a broker that sends the headers and then stalls", async () => {
    const stalled = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"mess');
    });
    await new Promise<void>((r) => stalled.listen(0, "127.0.0.1", r));
    const address = stalled.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    try {
      const run = await hook({ ...withUrl(`http://127.0.0.1:${address.port}`), timeoutMs: 200 });
      expect(run).toMatchObject({ out: [], code: 0 });
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((r) => stalled.close(() => r()));
    }
  });

  it("prints nothing for bad stdin, and does not call the broker", async () => {
    const s = await stub((respond) => respond(200, '{"messages":["x"]}'));
    for (const stdin of ["", "not json", "[]", "{}", '{"conversationId":""}', '{"conversationId":7}']) {
      const run = await hook({ ...withUrl(s.url), stdin });
      expect(run, stdin).toMatchObject({ out: [], code: 0 });
    }
    expect(s.seen).toEqual([]);
  });

  it("prints nothing when the broker refuses the token, or fails, or answers nonsense", async () => {
    for (const [status, body] of [[401, "a bearer token is required"], [403, "no"], [500, "oops"], [200, "not json"], [200, '{"messages":"x"}'], [200, '{"messages":[1]}'], [200, '{"messages":["x"]}'], [200, "{}"]] as const) {
      const s = await stub((respond) => respond(status, body));
      const run = await hook(withUrl(s.url));
      expect(run.out, `${status} ${body}`).toEqual([]);
      expect(run.code).toBe(0);
      expect(run.err).toHaveLength(1);
      expect(run.err.join("")).not.toContain("secret-token");
    }
  });

  it("prints nothing when its settings or the token file are bad", async () => {
    const s = await stub((respond) => respond(200, '{"messages":["x"]}'));
    for (const over of [
      { env: {} },
      { env: { ELSERELAY_URL: s.url } },
      { env: { ELSERELAY_URL: "not a url", ELSERELAY_TOKEN_FILE: "/t" } },
      { ...withUrl(s.url), readFile: async () => { throw new Error("ENOENT"); } },
      { ...withUrl(s.url), readFile: async () => "  \n" },
    ] satisfies Partial<HookDeps>[]) {
      expect(await hook(over)).toMatchObject({ out: [], code: 0 });
    }
    expect(s.seen).toEqual([]);
  });
});

describe("the Antigravity hook against a real broker", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("collects a message once and then finds the inbox empty", async () => {
    h = await startHarness({ policy: ALLOW_ALL });
    const a = await fakeAdapter(h, "alpha");
    await pullOnly(a, "conv-1");
    const sent = h.running.service.send("beta", { session: "b1", title: "Beta" }, { container: "alpha", session: "conv-1" }, "please look at the build");
    expect(sent.kind).toBe("accepted");
    const url = `http://127.0.0.1:${h.running.adapterPort}`;
    const env = { ELSERELAY_URL: url, ELSERELAY_TOKEN_FILE: "/token" };
    const first = await hook({ env, readFile: async () => TOKENS["alpha"] ?? "" });
    const parsed = JSON.parse(first.out[0] ?? "{}") as { injectSteps: { userMessage: string }[] };
    expect(parsed.injectSteps).toHaveLength(1);
    expect(parsed.injectSteps[0]?.userMessage).toContain("please look at the build");
    expect(parsed.injectSteps[0]?.userMessage).toContain('Container: "beta" (verified by the gateway)');
    expect(h.running.store.get(sent.kind === "accepted" ? sent.id : "")?.state).toBe("delivered");
    const second = await hook({ env, readFile: async () => TOKENS["alpha"] ?? "" });
    expect(second.out).toEqual([]);
    a.close();
  });

  it("is refused a token that is not a container's", async () => {
    h = await startHarness({ policy: ALLOW_ALL });
    const url = `http://127.0.0.1:${h.running.adapterPort}`;
    const run = await hook({ env: { ELSERELAY_URL: url, ELSERELAY_TOKEN_FILE: "/t" }, readFile: async () => "ghost-token-wrong-0123" });
    expect(run).toMatchObject({ out: [], code: 0 });
    expect(run.err.join("")).toContain("401");
  });
});

// The real program, built as `npm run build` builds it, with a real stdin and stdout.
describe("the elserelay program", () => {
  let build: string;
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "elserelay-bin-"));
    // Under node_modules, so the built files find the same packages the sources do.
    build = join(ROOT, "node_modules", ".cache", `elserelay-bin-${process.pid}`);
    execFileSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", join(ROOT, "tsconfig.build.json"), "--outDir", build], { cwd: ROOT, stdio: "pipe" });
  }, 120_000);
  afterAll(() => {
    rmSync(build, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  type Result = { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly ms: number };
  const bin = (args: readonly string[], env: Record<string, string>, stdin: string | null, ms = 15_000): Promise<Result> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(process.execPath, [join(build, "cli.js"), ...args], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`the program did not finish within ${ms} ms`));
      }, ms);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, ms: Date.now() - started });
      });
      if (stdin !== null) child.stdin.end(stdin);
    });

  const tokenFile = (token: string): string => {
    const path = join(work, `token-${Math.random().toString(16).slice(2)}`);
    writeFileSync(path, `${token}\n`);
    return path;
  };

  it("hook antigravity: JSON in on stdin, the injected steps out on stdout", async () => {
    const h = await startHarness({ policy: ALLOW_ALL });
    try {
      const a = await fakeAdapter(h, "alpha");
      await pullOnly(a, "conv-7");
      h.running.service.send("beta", { session: "b1", title: null }, { container: "alpha", session: "conv-7" }, "ping from beta");
      const env = { ELSERELAY_URL: `http://127.0.0.1:${h.running.adapterPort}`, ELSERELAY_TOKEN_FILE: tokenFile(TOKENS["alpha"] ?? "") };
      const input = JSON.stringify({ conversationId: "conv-7", workspacePaths: [], invocationNum: 0 });

      const first = await bin(["hook", "antigravity"], env, input);
      expect(first.code).toBe(0);
      expect(first.stderr).toBe("");
      const steps = JSON.parse(first.stdout) as { injectSteps: { userMessage: string }[] };
      expect(steps.injectSteps).toHaveLength(1);
      expect(steps.injectSteps[0]?.userMessage).toContain("ping from beta");

      const second = await bin(["hook", "antigravity"], env, input);
      expect(second).toMatchObject({ code: 0, stdout: "" });
      a.close();
    } finally {
      await h.close();
    }
  }, 30_000);

  it("hook antigravity: nothing on stdout and exit 0 with no broker, a bad token, bad stdin and no settings", async () => {
    const h = await startHarness({ policy: ALLOW_ALL });
    const url = `http://127.0.0.1:${h.running.adapterPort}`;
    await h.close();
    const input = JSON.stringify({ conversationId: "c" });
    const cases: [string, Record<string, string>, string | null][] = [
      ["no broker", { ELSERELAY_URL: url, ELSERELAY_TOKEN_FILE: tokenFile("x".repeat(20)) }, input],
      ["bad stdin", { ELSERELAY_URL: url, ELSERELAY_TOKEN_FILE: tokenFile("x".repeat(20)) }, "{{{"],
      ["empty stdin", { ELSERELAY_URL: url, ELSERELAY_TOKEN_FILE: tokenFile("x".repeat(20)) }, ""],
      ["no settings", {}, input],
      ["no token file", { ELSERELAY_URL: url, ELSERELAY_TOKEN_FILE: join(work, "missing") }, input],
    ];
    for (const [name, env, stdin] of cases) {
      const run = await bin(["hook", "antigravity"], env, stdin);
      expect(run.stdout, name).toBe("");
      expect(run.code, name).toBe(0);
    }
  }, 30_000);

  it("hook antigravity: a 401 from a live broker prints nothing", async () => {
    const h = await startHarness({ policy: ALLOW_ALL });
    try {
      const env = { ELSERELAY_URL: `http://127.0.0.1:${h.running.adapterPort}`, ELSERELAY_TOKEN_FILE: tokenFile("not-a-token-0123456789") };
      const run = await bin(["hook", "antigravity"], env, JSON.stringify({ conversationId: "c" }));
      expect(run).toMatchObject({ code: 0, stdout: "" });
      expect(run.stderr).toContain("401");
    } finally {
      await h.close();
    }
  }, 30_000);

  it("hook antigravity: a broker that never answers costs three seconds and nothing else", async () => {
    const s = await stub(() => undefined);
    const env = { ELSERELAY_URL: s.url, ELSERELAY_TOKEN_FILE: tokenFile("x".repeat(20)) };
    const run = await bin(["hook", "antigravity"], env, JSON.stringify({ conversationId: "c" }));
    expect(run).toMatchObject({ code: 0, stdout: "" });
    expect(run.ms).toBeGreaterThanOrEqual(2900);
    expect(run.ms).toBeLessThan(5500);
  }, 30_000);

  it("hook antigravity: does not wait for a stdin that stays open after the JSON", async () => {
    const s = await stub((respond) => respond(200, '{"messages":["hi"]}'));
    const env = { ELSERELAY_URL: s.url, ELSERELAY_TOKEN_FILE: tokenFile("x".repeat(20)) };
    // The JSON is written but stdin is never ended, so reading to the end would wait for the deadline.
    const run = await new Promise<Result>((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [join(build, "cli.js"), "hook", "antigravity"], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.on("close", (code) => resolve({ code, stdout, stderr: "", ms: Date.now() - started }));
      child.stdin.write(JSON.stringify({ conversationId: "c" }));
    });
    // Whatever it does, it ends within the hook's time and breaks nothing.
    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(5500);
  }, 30_000);

  it("hook claude and hook codex: the built program answers from stdin alone, with no settings and no broker", async () => {
    const input = JSON.stringify({ session_id: "sid-1", tool_name: "mcp__elserelay__inbox", tool_input: { received: [] } });
    const claude = await bin(["hook", "claude"], {}, input);
    expect(claude).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(claude.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { received: [], session: "sid-1" } } });
    const codex = await bin(["hook", "codex"], { ELSERELAY_HOOK_SERVER: "elserelay" }, input);
    expect(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
    const other = await bin(["hook", "codex"], {}, JSON.stringify({ session_id: "s", tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(other).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const garbage = await bin(["hook", "claude"], {}, "not json");
    expect(garbage).toMatchObject({ code: 0, stdout: "", stderr: "" });
  }, 30_000);

  it("adapter: refuses to start without its settings", async () => {
    const run = await bin(["adapter"], {}, null);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("bad settings");
    expect(run.stderr).toContain("ELSERELAY_URL");
  });

  it("an unknown command prints the usage and fails", async () => {
    const run = await bin(["hook", "somewhere-else"], {}, null);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("usage: elserelay");
  });

  it("stop and start show in the audit the program prints", async () => {
    const h = await startHarness({ policy: ALLOW_ALL });
    try {
      const env = { ELSERELAY_CONFIG: h.configPath };
      expect((await bin(["stop"], env, null)).code).toBe(0);
      expect((await bin(["start"], env, null)).code).toBe(0);
      const audit = await bin(["audit", "--since", "2020-01-01T00:00:00Z"], env, null);
      expect(audit.stdout.split("\n").filter((l) => l !== "").map((l) => l.split(" ").slice(1).join(" "))).toEqual(["stop by the operator", "start by the operator"]);
    } finally {
      await h.close();
    }
  }, 30_000);
});

