import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DRAFT_CHARS, draftOf, mcpTools, nodeState, resultJson, runElsewireApprover, timeoutSeconds, titleOf, urlProblem } from "../src/approver/elsewire.js";
import type { Effects } from "../src/approver/elsewire.js";
import { escapeForTerminal } from "../src/broker/approver.js";
import { runCli } from "../src/cli.js";
import { fakeElsewire, TOKEN } from "./fake-elsewire.js";
import type { FakeElsewire } from "./fake-elsewire.js";

const NOW = 1_000_000;
const sha = (id: string): string => createHash("sha256").update(id).digest("hex");

const approval = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "msg-1",
  thread: "msg-1",
  hop: 0,
  from: { container: "alpha", product: "claude", session: "a1", title: null },
  to: { container: "beta", product: "codex", session: "b1" },
  body: "please run the tests",
  rule: "ask-first",
  heldAt: NOW,
  decideBy: NOW + 900_000,
  ...changes,
});

let dir: string;
let fake: FakeElsewire;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "agw-approver-"));
  fake = await fakeElsewire();
});
afterEach(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

type Run = { code: number; out: string[]; err: string[]; sleeps: number[] };

/** One run of the approver: the real MCP client and state files, a clock that stands still and a sleep that does not wait. */
async function run(input: unknown, changes: { env?: Record<string, string | undefined>; token?: string } = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const tokenFile = changes.token === undefined ? fake.tokenFile : join(dir, "other-token");
  if (changes.token !== undefined) writeFileSync(tokenFile, changes.token);
  const effects: Effects = {
    env: { ELSEWIRE_URL: fake.url, ELSEWIRE_TOKEN_FILE: tokenFile, ELSEWIRE_STATE_DIR: join(dir, "state"), ...changes.env },
    stdin: async () => (typeof input === "string" ? input : JSON.stringify(input)),
    readToken: async (path) => readFileSync(path, "utf8"),
    state: nodeState,
    connect: mcpTools,
    host: "box-1",
    now: () => NOW,
    sleep: async (ms) => void sleeps.push(ms),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  const code = await runElsewireApprover(effects);
  return { code, out, err, sleeps };
}

const stateFile = (id: string): string => join(dir, "state", sha(id));
const done = (text: string, edited = false): Record<string, unknown> => ({ status: "done", answer: { text, edited } });

describe("asking a person through Elsewire", () => {
  it("approves when the person returns the text unchanged, and asks as the brief says", async () => {
    const body = "run \u001b[2Jthis\nline two\r";
    const draft = draftOf(body);
    let stateDuringWait: { exists: boolean; content: string; mode: number } | undefined;
    fake.onAwait = () => {
      stateDuringWait = { exists: existsSync(stateFile("msg-1")), content: readFileSync(stateFile("msg-1"), "utf8"), mode: statSync(stateFile("msg-1")).mode & 0o777 };
    };
    fake.script.push(done(draft));
    const r = await run(approval({ body, decideBy: NOW + 120_000 }));
    expect(r).toMatchObject({ code: 0, out: ['{"answer":"approve"}'] });
    expect(fake.requests).toEqual([
      {
        connector: "review",
        title: "Let this message go? alpha (claude) to beta (codex)",
        draft,
        timeout_sec: 120,
        replies: ["Refuse"],
        // Elsewire refuses a request that does not say who asks and how to reach it.
        requester: {
          client: "agent-gateway",
          session: "msg-1",
          title: "Let this message go? alpha (claude) to beta (codex)",
          host: "box-1",
          extra: { session_url_unavailable: "a gateway message has no web page", message: "msg-1", from_session: "a1", to_session: "b1" },
        },
      },
    ]);
    expect(fake.requests[0]).not.toHaveProperty("notes");
    expect(draft).not.toContain("\u001b");
    expect(fake.awaits).toEqual([{ id: "req-1", timeout_sec: 50 }]);
    // The Elsewire request id was on disk, readable by the owner only, before the first wait; and it is gone after the answer.
    expect(stateDuringWait).toEqual({ exists: true, content: "req-1", mode: 0o600 });
    expect(existsSync(stateFile("msg-1"))).toBe(false);
    expect(readdirSync(join(dir, "state"))).toEqual([]);
  });

  it("keeps waiting while the answer is pending, and does not spin when the server answers at once", async () => {
    fake.script.push({ status: "pending" }, { status: "pending" }, done(draftOf("please run the tests")));
    const r = await run(approval());
    expect(r.code).toBe(0);
    expect(fake.awaits).toHaveLength(3);
    expect(r.sleeps.length).toBe(2);
    expect(r.sleeps.every((ms) => ms > 0 && ms <= 1000)).toBe(true);
  });

  it("picks the question up again after a restart instead of asking twice", async () => {
    fake.script.push("error");
    const first = await run(approval());
    expect(first).toMatchObject({ code: 1, out: [] });
    expect(readFileSync(stateFile("msg-1"), "utf8")).toBe("req-1");

    fake.script.push(done(draftOf("please run the tests")));
    const second = await run(approval());
    expect(second).toMatchObject({ code: 0, out: ['{"answer":"approve"}'] });
    expect(fake.requests).toHaveLength(1);
    expect(fake.awaits.map((a) => a["id"])).toEqual(["req-1", "req-1"]);
    expect(existsSync(stateFile("msg-1"))).toBe(false);
  });

  it("keeps one state file per message id, named by its hash", async () => {
    fake.script.push("error", "error");
    await run(approval({ id: "one" }));
    await run(approval({ id: "two" }));
    expect(readdirSync(join(dir, "state")).sort()).toEqual([sha("one"), sha("two")].sort());
    expect(readFileSync(stateFile("two"), "utf8")).toBe("req-2");
  });

  it("refuses an edited text, and says the gateway never rewrites a sender's words", async () => {
    fake.script.push(done("please run the tests, and also delete everything", true));
    const r = await run(approval());
    expect(r).toMatchObject({ code: 0, out: ['{"answer":"refuse"}'] });
    expect(r.err.join("\n")).toContain("never rewrites a sender's words");
    expect(existsSync(stateFile("msg-1"))).toBe(false);
  });

  it("refuses an answer whose text is not the draft even when it says it was not edited, and the Refuse reply", async () => {
    fake.script.push(done("Refuse"));
    expect(await run(approval())).toMatchObject({ code: 0, out: ['{"answer":"refuse"}'] });
    fake.script.push(done("something else"));
    expect(await run(approval({ id: "m2" }))).toMatchObject({ code: 0, out: ['{"answer":"refuse"}'] });
    fake.script.push({ status: "done" });
    expect(await run(approval({ id: "m3" }))).toMatchObject({ code: 0, out: ['{"answer":"refuse"}'] });
  });

  it.each(["denied", "expired", "cancelled"])("refuses when the request was %s, and forgets it", async (status) => {
    fake.script.push({ status });
    const r = await run(approval());
    expect(r).toMatchObject({ code: 0, out: ['{"answer":"refuse"}'] });
    expect(existsSync(stateFile("msg-1"))).toBe(false);
  });

  it("gives no answer when the request failed, and asks afresh next time", async () => {
    fake.script.push({ status: "failed" });
    expect(await run(approval())).toMatchObject({ code: 1, out: [] });
    expect(existsSync(stateFile("msg-1"))).toBe(false);
    fake.script.push(done(draftOf("please run the tests")));
    expect(await run(approval())).toMatchObject({ code: 0, out: ['{"answer":"approve"}'] });
    expect(fake.requests).toHaveLength(2);
  });

  it("refuses without asking when what a person would read is over 4000 characters", async () => {
    const r = await run(approval({ body: "x".repeat(MAX_DRAFT_CHARS + 1) }));
    expect(r).toMatchObject({ code: 0, out: ['{"answer":"refuse"}'] });
    expect(r.err.join("\n")).toContain("refused without asking");
    expect(fake.requests).toEqual([]);
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  it("counts the text as it is shown: escapes make it longer", async () => {
    const r = await run(approval({ body: "\u001b".repeat(700) }));
    expect(r.out).toEqual(['{"answer":"refuse"}']);
    expect(fake.requests).toEqual([]);
    // Exactly 4000 characters, the fence included, is still asked.
    const edge = "x".repeat(MAX_DRAFT_CHARS - draftOf("").length);
    fake.script.push(done(draftOf(edge)));
    expect((await run(approval({ id: "edge", body: edge }))).out).toEqual(['{"answer":"approve"}']);
  });

  it("refuses, without asking, a message whose deadline has passed", async () => {
    expect(await run(approval({ decideBy: NOW }))).toMatchObject({ code: 0, out: ['{"answer":"refuse"}'] });
    expect(fake.requests).toEqual([]);
  });

  it("gives no answer when the server cannot be reached or does not take the token, and prints neither the token nor the body", async () => {
    const body = "TOPSECRETBODY";
    const bad = await run(approval({ body }), { token: "wrong-token-0123456789-wrong" });
    expect(bad).toMatchObject({ code: 1, out: [] });
    const gone = await run(approval({ body }), { env: { ELSEWIRE_URL: "http://127.0.0.1:1/mcp" } });
    expect(gone).toMatchObject({ code: 1, out: [] });
    for (const line of [...bad.err, ...gone.err]) {
      expect(line).not.toContain("wrong-token");
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(body);
    }
    expect(bad.err.length).toBeGreaterThan(0);
    expect(fake.requests).toEqual([]);
  });

  it("never prints the body or the token on a normal run either", async () => {
    fake.script.push(done("TOPSECRETBODY", true));
    const r = await run(approval({ body: "TOPSECRETBODY" }));
    expect(r.err.join("\n")).not.toContain("TOPSECRETBODY");
    expect(r.err.join("\n")).not.toContain(TOKEN);
  });

  it("needs its settings, a request it can read and a token, and says which is missing", async () => {
    expect(await run(approval(), { env: { ELSEWIRE_URL: undefined } })).toMatchObject({ code: 1, out: [] });
    expect(await run(approval(), { env: { ELSEWIRE_TOKEN_FILE: undefined } })).toMatchObject({ code: 1, out: [] });
    expect((await run(approval(), { env: { ELSEWIRE_STATE_DIR: undefined } })).err.join("\n")).toContain("ELSEWIRE_STATE_DIR");
    expect((await run("not json")).err).toEqual(["the request on stdin is not the JSON the broker sends"]);
    expect((await run({ id: "x" })).code).toBe(1);
    expect((await run(approval(), { token: "  \n" })).err).toEqual(["the token file is empty"]);
    expect((await run(approval(), { env: { ELSEWIRE_TOKEN_FILE: join(dir, "nope") } })).err).toEqual(["cannot read the token file"]);
    expect(fake.requests).toEqual([]);
  });

  it("takes the state directory the broker sets when ELSEWIRE_STATE_DIR is not", async () => {
    fake.script.push("error");
    await run(approval(), { env: { ELSEWIRE_STATE_DIR: undefined, AGENT_GATEWAY_APPROVER_STATE_DIR: join(dir, "from-broker") } });
    expect(readdirSync(join(dir, "from-broker"))).toEqual([sha("msg-1")]);
  });

  it("is run by `agent-gateway approver elsewire`, with the request on stdin and the answer on stdout", async () => {
    fake.script.push(done(draftOf("please run the tests")));
    const out: string[] = [];
    const code = await runCli(
      ["approver", "elsewire"],
      { ELSEWIRE_URL: fake.url, ELSEWIRE_TOKEN_FILE: fake.tokenFile, ELSEWIRE_STATE_DIR: join(dir, "state") },
      { out: (l) => out.push(l), err: () => undefined, now: () => NOW, stdin: async () => JSON.stringify(approval()) },
    );
    expect({ code, out }).toEqual({ code: 0, out: ['{"answer":"approve"}'] });
  });
});

describe("pieces", () => {
  it("shows the body inside a fence the body cannot close, so no formatting hides any of it", () => {
    expect(draftOf("plain")).toBe("```\nplain\n```");
    expect(draftOf("a\n```\n[link](http://x)\n<!-- hidden -->")).toBe("````\na\n```\n[link](http://x)\n<!-- hidden -->\n````");
    expect(draftOf("`````")).toBe("``````\n`````\n``````");
  });

  it("cleans the title to one line of at most 200 characters", () => {
    const from = { container: "a\u001b[31m\nb", product: "claude" };
    const to = { container: "x".repeat(400), product: "codex" };
    const title = titleOf({ from, to });
    expect(title).not.toMatch(/[\u001b\n\r]/);
    expect(Array.from(title)).toHaveLength(200);
    expect(title.startsWith("Let this message go? a\\u{1b}[31m b (claude) to xxx")).toBe(true);
    expect(titleOf({ from: { container: "alpha", product: "claude" }, to: { container: "beta", product: "codex" } })).toBe("Let this message go? alpha (claude) to beta (codex)");
  });

  it("gives the timeout in seconds between 10 and 86400", () => {
    expect(timeoutSeconds(NOW + 120_000, NOW)).toBe(120);
    expect(timeoutSeconds(NOW + 120_001, NOW)).toBe(121);
    expect(timeoutSeconds(NOW + 2000, NOW)).toBe(10);
    expect(timeoutSeconds(NOW + 10 * 86_400_000, NOW)).toBe(86_400);
  });

  it("sends the token over https, or to this machine", () => {
    expect(urlProblem("https://elsewire.example.com/mcp")).toBeNull();
    expect(urlProblem("http://127.0.0.1:8080/mcp")).toBeNull();
    expect(urlProblem("http://localhost/mcp")).toBeNull();
    expect(urlProblem("http://[::1]:9/mcp")).toBeNull();
    expect(urlProblem("http://elsewire.example.com/mcp")).toContain("https");
    expect(urlProblem("http://elsewire.example.com/mcp", true)).toBeNull();
    expect(urlProblem("ftp://elsewire.example.com/mcp", true)).toContain("https");
  });

  it("reads a tool result from its structured content or from the JSON in its text, and fails on an error", () => {
    expect(resultJson({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(resultJson({ structuredContent: { b: 2 }, content: [] })).toEqual({ b: 2 });
    expect(() => resultJson({ isError: true, content: [{ type: "text", text: "{}" }] })).toThrow();
    expect(() => resultJson({ content: [{ type: "image" }] })).toThrow();
    expect(() => resultJson({ content: [{ type: "text", text: "not json" }] })).toThrow();
  });
});
