import { describe, expect, it } from "vitest";
import { childEnv, makeCommandApprover, parseAnswer, requestJson, retryDelay } from "../src/broker/command.js";
import type { Child, ChildResult, StopWhy, Timing } from "../src/broker/command.js";
import type { Answered, ApprovalRequest } from "../src/broker/service.js";

const request = (id: string, changes: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id,
  thread: id,
  hop: 1,
  from: { container: "alpha", product: "claude", session: "a1", title: "Alpha one" },
  to: { container: "beta", product: "codex", session: "b1" },
  body: "SECRET BODY TEXT",
  rule: "ask-first",
  heldAt: 1000,
  decideBy: 901_000,
  ...changes,
});

describe("requestJson", () => {
  it("is the documented object and nothing else", () => {
    expect(JSON.parse(requestJson(request("m1")))).toEqual({
      id: "m1",
      thread: "m1",
      hop: 1,
      from: { container: "alpha", product: "claude", session: "a1", title: "Alpha one" },
      to: { container: "beta", product: "codex", session: "b1" },
      body: "SECRET BODY TEXT",
      rule: "ask-first",
      heldAt: 1000,
      decideBy: 901_000,
    });
  });

  it("carries a missing rule and title as null, and leaves out what the broker adds to a request later", () => {
    const extended = { ...request("m2", { rule: null, from: { container: "a", product: "claude", session: "s", title: null } }), internal: "x" };
    const json = JSON.parse(requestJson(extended)) as Record<string, unknown>;
    expect(json["rule"]).toBeNull();
    expect((json["from"] as Record<string, unknown>)["title"]).toBeNull();
    expect(json).not.toHaveProperty("internal");
  });
});

describe("childEnv", () => {
  const source = { PATH: "/bin", HOME: "/home/x", LANG: "C", BROKER_SECRET: "s3cret", TOKEN: "t", ELSEWIRE_URL: "https://e" };

  it("holds PATH, HOME and LANG and nothing else of the broker's own", () => {
    expect(childEnv(source, [], undefined)).toEqual({ PATH: "/bin", HOME: "/home/x", LANG: "C" });
  });

  it("adds the names the config passes through, and only those that are set", () => {
    expect(childEnv(source, ["ELSEWIRE_URL", "ABSENT"], undefined)).toEqual({ PATH: "/bin", HOME: "/home/x", LANG: "C", ELSEWIRE_URL: "https://e" });
  });

  it("tells the command where to keep its state when the config names a directory", () => {
    expect(childEnv({ PATH: "/bin" }, [], "/data/approver")).toEqual({ PATH: "/bin", AGENT_GATEWAY_APPROVER_STATE_DIR: "/data/approver" });
  });
});

describe("parseAnswer", () => {
  it("accepts exactly an approve or a refuse object, with a line end around it", () => {
    expect(parseAnswer('{"answer":"approve"}\n')).toEqual({ answer: "approve" });
    expect(parseAnswer(' {"answer":"refuse"} ')).toEqual({ answer: "refuse" });
  });

  it("takes a refusal with the one reason code there is, and no other reason", () => {
    expect(parseAnswer('{"answer":"refuse","reason":"too-long"}')).toEqual({ answer: "refuse", reason: "too-long" });
    for (const bad of ['{"answer":"refuse","reason":"because"}', '{"answer":"refuse","reason":""}', '{"answer":"refuse","reason":null}', '{"answer":"refuse","reason":["too-long"]}', '{"answer":"approve","reason":"too-long"}']) {
      expect(parseAnswer(bad)).toBeNull();
    }
  });

  it("takes anything else as no answer", () => {
    for (const bad of ["", "approve", "{", '{"answer":"yes"}', '{"answer":"APPROVE"}', '{"answer":true}', '{"answer":"approve"}\n{"answer":"approve"}', "[]", "null", '"approve"', '{"result":"approve"}']) {
      expect(parseAnswer(bad)).toBeNull();
    }
  });
});

describe("retryDelay", () => {
  it("starts at 30 s, doubles, and stops at 5 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => retryDelay(n, 30_000, 300_000))).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  });
});

/** A program that does what the test says, and a clock that moves when the test says. */
function rig(timing?: Timing) {
  let t = 1000;
  const logs: string[] = [];
  const answered: string[] = [];
  let applied: Answered | (() => Answered) = { ok: true };
  type Run = { argv: readonly string[]; env: Readonly<Record<string, string>>; input: string; finish: (r: ChildResult) => void; stopped: boolean; why: StopWhy | null };
  const runs: Run[] = [];
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const spawn = (argv: readonly string[], env: Readonly<Record<string, string>>, input: string): Child => {
    let finish: (r: ChildResult) => void = () => undefined;
    const done = new Promise<ChildResult>((resolve) => {
      finish = resolve;
    });
    const run: Run = { argv, env, input, finish, stopped: false, why: null };
    runs.push(run);
    return {
      done,
      stop: (why) => {
        run.stopped = true;
        run.why ??= why;
        finish({ ok: false, why: "stopped", stderr: "" });
      },
    };
  };
  const approver = makeCommandApprover({
    argv: ["prog", "--flag"],
    passEnv: [],
    env: { PATH: "/bin", SECRET: "no" },
    service: {
      approve: (id) => (answered.push(`approve ${id}`), typeof applied === "function" ? applied() : applied),
      refuse: (id, reason) => (answered.push(reason === undefined ? `refuse ${id}` : `refuse ${id} (${reason})`), typeof applied === "function" ? applied() : applied),
    },
    spawn,
    after: (ms, fn) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    now: () => t,
    log: (line) => logs.push(line),
    ...(timing === undefined ? {} : { timing }),
  });
  /** Moves the clock and runs what fell due, then lets answers that were just given settle. */
  const advance = async (ms: number): Promise<void> => {
    t += ms;
    for (const timer of timers.filter((x) => x.live && x.at <= t)) {
      timer.live = false;
      timer.fn();
    }
    await settle();
  };
  return { approver, runs, logs, answered, advance, setApplied: (a: typeof applied) => (applied = a), now: () => t };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};
const ok = (stdout: string): ChildResult => ({ ok: true, stdout, stderr: "" });
const failed = (why: string): ChildResult => ({ ok: false, why, stderr: "" });

describe("the command approver", () => {
  it("starts the program once per message, with the request on its input and a trimmed environment", async () => {
    const r = rig();
    await r.approver.ask(request("m1"));
    await r.approver.ask(request("m1"));
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]?.argv).toEqual(["prog", "--flag"]);
    expect(r.runs[0]?.env).toEqual({ PATH: "/bin" });
    expect(JSON.parse(r.runs[0]?.input ?? "")).toMatchObject({ id: "m1", body: "SECRET BODY TEXT" });
  });

  it("passes an approve and a refuse on through the service", async () => {
    const r = rig();
    await r.approver.ask(request("m1"));
    await r.approver.ask(request("m2"));
    r.runs[0]?.finish(ok('{"answer":"approve"}\n'));
    r.runs[1]?.finish(ok('{"answer":"refuse"}\n'));
    await settle();
    expect(r.answered).toEqual(["approve m1", "refuse m2"]);
    // Answered: nothing is run again for them.
    await r.advance(10 * 60_000);
    expect(r.runs).toHaveLength(2);
  });

  it("takes a failure, bad JSON, no output, too much output and a wrong answer as no answer, and never as a yes", async () => {
    const r = rig();
    await r.approver.ask(request("m1", { decideBy: 10_000_000 }));
    const results = [failed("exit code 1"), ok("not json"), failed("no output"), failed("output too long"), ok('{"answer":"maybe"}'), ok('{"answer":"approve"}\nextra')];
    let delay = 30_000;
    for (const [i, result] of results.entries()) {
      expect(r.runs).toHaveLength(i + 1);
      r.runs[i]?.finish(result);
      await settle();
      await r.advance(delay - 1);
      expect(r.runs).toHaveLength(i + 1);
      await r.advance(1);
      delay = Math.min(delay * 2, 300_000);
    }
    expect(r.answered).toEqual([]);
    expect(r.runs).toHaveLength(results.length + 1);
  });

  it("tries again after 30 s, then 60 s, and an answer on a later try counts", async () => {
    const r = rig();
    await r.approver.ask(request("m1"));
    r.runs[0]?.finish(failed("exit code 1"));
    await settle();
    await r.advance(29_999);
    expect(r.runs).toHaveLength(1);
    await r.advance(1);
    expect(r.runs).toHaveLength(2);
    r.runs[1]?.finish(failed("exit code 1"));
    await settle();
    await r.advance(59_999);
    expect(r.runs).toHaveLength(2);
    await r.advance(1);
    expect(r.runs).toHaveLength(3);
    r.runs[2]?.finish(ok('{"answer":"approve"}'));
    await settle();
    expect(r.answered).toEqual(["approve m1"]);
  });

  it("logs a failure without the body, and the program's own stderr line by line", async () => {
    const r = rig();
    await r.approver.ask(request("m1"));
    r.runs[0]?.finish({ ok: false, why: "exit code 3", stderr: "could not reach the server\n\u001b[31mred\u001b[0m\n" });
    await settle();
    const log = r.logs.join("\n");
    expect(log).toContain("approver command gave no answer for message m1 (exit code 3); trying again in 30 s");
    expect(log).toContain("approver command for message m1: could not reach the server");
    expect(log).not.toContain("\u001b");
    expect(log).not.toContain("SECRET BODY TEXT");
    // Not even the output that was not an answer is quoted.
    r.runs[0]?.finish(ok("SECRET BODY TEXT is what it printed"));
    await r.advance(30_000);
    r.runs[1]?.finish(ok("SECRET BODY TEXT is what it printed"));
    await settle();
    expect(r.logs.join("\n")).not.toContain("SECRET BODY TEXT");
  });

  it("stops the program and the retries at the deadline", async () => {
    const r = rig();
    await r.approver.ask(request("m1", { decideBy: 1000 + 100_000 }));
    await r.advance(99_999);
    expect(r.runs[0]?.stopped).toBe(false);
    await r.advance(1);
    expect(r.runs[0]?.stopped).toBe(true);
    await r.advance(10 * 60_000);
    expect(r.runs).toHaveLength(1);
    expect(r.answered).toEqual([]);
  });

  it("stops waiting between tries at the deadline too", async () => {
    const r = rig();
    await r.approver.ask(request("m1", { decideBy: 1000 + 40_000 }));
    r.runs[0]?.finish(failed("exit code 1"));
    await settle();
    await r.advance(30_000);
    expect(r.runs).toHaveLength(2);
    r.runs[1]?.finish(failed("exit code 1"));
    await settle();
    await r.advance(20_000);
    expect(r.runs).toHaveLength(2);
  });

  it("stops the program when the message stops being held, and does not ask again", async () => {
    const r = rig();
    await r.approver.ask(request("m1"));
    await r.approver.ask(request("m2"));
    r.approver.sync?.(new Set(["m2"]));
    await settle();
    expect(r.runs.map((x) => x.stopped)).toEqual([true, false]);
    await r.advance(10 * 60_000);
    expect(r.runs).toHaveLength(2);
    // A message that comes back to the held state (a rule that now asks) is asked about afresh.
    await r.approver.ask(request("m1"));
    expect(r.runs).toHaveLength(3);
  });

  it("does not answer for a message whose program ended after it was stopped", async () => {
    const r = rig();
    await r.approver.ask(request("m1"));
    r.approver.sync?.(new Set());
    r.runs[0]?.finish(ok('{"answer":"approve"}'));
    await settle();
    expect(r.answered).toEqual([]);
  });

  it("runs at most 16 programs at once, and the others wait for a free place in order", async () => {
    const r = rig();
    for (let i = 0; i < 20; i++) await r.approver.ask(request(`m${i}`));
    expect(r.runs).toHaveLength(16);
    r.runs[3]?.finish(ok('{"answer":"approve"}'));
    await settle();
    expect(r.runs).toHaveLength(17);
    expect(JSON.parse(r.runs[16]?.input ?? "").id).toBe("m16");
    r.runs[0]?.finish(ok('{"answer":"refuse"}'));
    r.runs[1]?.finish(ok('{"answer":"refuse"}'));
    r.runs[2]?.finish(ok('{"answer":"refuse"}'));
    await settle();
    expect(r.runs.map((x) => JSON.parse(x.input).id)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
    expect(r.runs).toHaveLength(20);
  });

  it("does not start a message that waited for a place past its deadline", async () => {
    const r = rig({ retryFirstMs: 30_000, retryMaxMs: 300_000, maxChildren: 1 });
    await r.approver.ask(request("m1"));
    await r.approver.ask(request("m2", { decideBy: 1000 + 50_000 }));
    await r.advance(60_000);
    r.runs[0]?.finish(ok('{"answer":"approve"}'));
    await settle();
    expect(r.runs).toHaveLength(1);
  });

  it("logs, and does not throw, when a yes arrives for a message that is no longer held", async () => {
    const r = rig();
    r.setApplied({ ok: false, why: "timed-out" });
    await r.approver.ask(request("m1"));
    r.runs[0]?.finish(ok('{"answer":"approve"}'));
    await settle();
    expect(r.logs.join("\n")).toContain("message m1, but it is not held any more (timed-out)");
    await r.advance(10 * 60_000);
    expect(r.runs).toHaveLength(1);
  });

  it("stops every program when the broker closes, waits for them, and then asks nothing more", async () => {
    const r = rig();
    await r.approver.ask(request("m1"));
    await r.approver.ask(request("m2"));
    await r.approver.close?.();
    expect(r.runs.map((x) => x.stopped)).toEqual([true, true]);
    await r.approver.ask(request("m3"));
    expect(r.runs).toHaveLength(2);
    await r.advance(10 * 60_000);
    expect(r.runs).toHaveLength(2);
  });

  it("tells a program why it is stopped: the question is moot, or only the broker is closing", async () => {
    const r = rig();
    await r.approver.ask(request("m1"));
    await r.approver.ask(request("m2"));
    await r.approver.ask(request("m3", { decideBy: 1000 + 5000 }));
    r.approver.sync?.(new Set(["m2", "m3"]));
    await r.advance(5000);
    expect(r.runs.map((x) => x.why)).toEqual(["moot", null, "moot"]);
    await r.approver.close?.();
    expect(r.runs.map((x) => x.why)).toEqual(["moot", "shutdown", "moot"]);
  });

  it("passes a refusal's reason code on to the service", async () => {
    const r = rig();
    await r.approver.ask(request("m1"));
    r.runs[0]?.finish(ok('{"answer":"refuse","reason":"too-long"}'));
    await settle();
    expect(r.answered).toEqual(["refuse m1 (too-long)"]);
    await r.approver.ask(request("m2"));
    r.runs[1]?.finish(ok('{"answer":"refuse","reason":"nonsense"}'));
    await settle();
    expect(r.answered).toEqual(["refuse m1 (too-long)"]);
    expect(r.logs.join("\n")).toContain("gave no answer for message m2");
  });

  it("does not end the broker when the service throws: it logs the error's name, never the body, and tries again as for no answer", async () => {
    const unhandled: unknown[] = [];
    const record = (e: unknown): number => unhandled.push(e);
    process.on("unhandledRejection", record);
    try {
      const r = rig();
      r.setApplied(() => {
        throw Object.assign(new Error("database is locked: SECRET BODY TEXT"), { name: "BusyError" });
      });
      await r.approver.ask(request("m1"));
      r.runs[0]?.finish(ok('{"answer":"approve"}'));
      await settle();
      // The write is tried again a few times, then the answer counts as none and the program runs again.
      for (let i = 0; i < 6; i++) await r.advance(250 * 2 ** i);
      expect(r.answered.length).toBe(5);
      expect(r.logs.join("\n")).toContain("the store failed (BusyError)");
      expect(r.logs.join("\n")).toContain("gave no answer for message m1 (the store stayed busy");
      expect(r.logs.join("\n")).not.toContain("SECRET BODY TEXT");
      await r.advance(30_000);
      expect(r.runs).toHaveLength(2);
      // Nothing is left in `running`: closing returns.
      r.runs[1]?.finish(ok('{"answer":"approve"}'));
      r.setApplied({ ok: true });
      await r.approver.close?.();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("writes a yes that met a busy store again after a short wait, and does not forget the message meanwhile", async () => {
    const r = rig();
    let busy = 2;
    r.setApplied(() => (busy-- > 0 ? { ok: false, why: "busy" } : { ok: true }));
    await r.approver.ask(request("m1"));
    r.runs[0]?.finish(ok('{"answer":"approve"}'));
    await settle();
    expect(r.answered).toEqual(["approve m1"]);
    expect(r.runs[0]?.stopped).toBe(false);
    await r.advance(250);
    expect(r.answered).toEqual(["approve m1", "approve m1"]);
    await r.advance(499);
    expect(r.answered).toHaveLength(2);
    await r.advance(1);
    expect(r.answered).toEqual(["approve m1", "approve m1", "approve m1"]);
    expect(r.logs.join("\n")).toContain("approver command approved message m1");
    await r.advance(10 * 60_000);
    expect(r.runs).toHaveLength(1);
  });

  it("gives up on a store that stays busy, treats it as no answer, and the next run's yes counts", async () => {
    const r = rig();
    r.setApplied({ ok: false, why: "busy" });
    await r.approver.ask(request("m1", { decideBy: 10_000_000 }));
    r.runs[0]?.finish(ok('{"answer":"approve"}'));
    await settle();
    for (let i = 0; i < 4; i++) await r.advance(250 * 2 ** i);
    expect(r.answered).toHaveLength(5);
    expect(r.logs.join("\n")).toContain("the store stayed busy");
    r.setApplied({ ok: true });
    await r.advance(30_000);
    expect(r.runs).toHaveLength(2);
    r.runs[1]?.finish(ok('{"answer":"approve"}'));
    await settle();
    expect(r.answered).toHaveLength(6);
  });

  it("stops writing a yes again when the message stops being held meanwhile", async () => {
    const r = rig();
    r.setApplied({ ok: false, why: "busy" });
    await r.approver.ask(request("m1"));
    r.runs[0]?.finish(ok('{"answer":"approve"}'));
    await settle();
    r.approver.sync?.(new Set());
    await r.advance(10_000);
    expect(r.answered).toEqual(["approve m1"]);
  });
});
