import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { nodeSpawn } from "../src/broker/spawn.js";
import { call, fakeAdapter, mcpClient, startHarness, waitFor } from "./http-rig.js";
import type { Harness } from "./http-rig.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agw-cmd-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Writes a Node program and returns the argv that runs it. */
function program(name: string, source: string): string[] {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, source);
  return [process.execPath, path];
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPid = (file: string): number => Number(readFileSync(file, "utf8"));
const ENV = { PATH: process.env["PATH"] ?? "" };

describe("nodeSpawn", () => {
  it("writes the input, closes it, and returns the output of a program that exits 0", async () => {
    const argv = program("echo", `let s = ""; for await (const c of process.stdin) s += c; process.stdout.write(JSON.stringify({ answer: JSON.parse(s).want }) + "\\n");`);
    const result = await nodeSpawn()(argv, ENV, JSON.stringify({ want: "approve" })).done;
    expect(result).toEqual({ ok: true, stdout: '{"answer":"approve"}\n', stderr: "" });
  });

  it("reports a non-zero exit, no output and a program that is not there, without any output of theirs", async () => {
    const run = (argv: string[]) => nodeSpawn()(argv, ENV, "{}").done;
    expect(await run(program("fail", `process.stdout.write("SECRET"); process.exit(3);`))).toMatchObject({ ok: false, why: "exit code 3" });
    expect(await run(program("silent", ``))).toMatchObject({ ok: false, why: "no output" });
    expect(await run([join(dir, "missing-program")])).toMatchObject({ ok: false, why: "could not start" });
  });

  it("does not run an argument through a shell", async () => {
    const argv = program("argv", `process.stdout.write(JSON.stringify(process.argv.slice(2)));`);
    const result = await nodeSpawn()([...argv, `$(touch ${join(dir, "pwned")}); echo hi`, "a b"], ENV, "{}").done;
    expect(result.ok && JSON.parse(result.stdout)).toEqual([`$(touch ${join(dir, "pwned")}); echo hi`, "a b"]);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("gives the program exactly the environment it was handed", async () => {
    process.env["BROKER_SECRET"] = "must-not-leak";
    try {
      const argv = program("env", `process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));`);
      const result = await nodeSpawn()(argv, { PATH: "/usr/bin", HOME: "/home/x" }, "{}").done;
      expect(result.ok && JSON.parse(result.stdout)).toEqual(["HOME", "PATH"]);
    } finally {
      delete process.env["BROKER_SECRET"];
    }
  });

  it("stops a program that prints more than 64 KiB, and that is no answer", async () => {
    const pidFile = join(dir, "pid");
    const argv = program("flood", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write("x".repeat(70_000)); setInterval(() => {}, 1000);`);
    const result = await nodeSpawn({ graceMs: 100 })(argv, ENV, "{}").done;
    expect(result).toMatchObject({ ok: false, why: "output too long" });
    expect(alive(readPid(pidFile))).toBe(false);
  });

  it("takes exactly 64 KiB of output", async () => {
    const argv = program("edge", `process.stdout.write("x".repeat(65_536));`);
    const result = await nodeSpawn()(argv, ENV, "{}").done;
    expect(result.ok && result.stdout.length).toBe(65_536);
  });

  it("stops a program with SIGTERM when it listens, and with SIGKILL after the grace when it does not, by its PID", async () => {
    const listens = join(dir, "listens");
    const ignores = join(dir, "ignores");
    const a = nodeSpawn({ graceMs: 3000 })(program("a", `import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => process.exit(0)); writeFileSync(${JSON.stringify(listens)}, String(process.pid)); setInterval(() => {}, 1000);`), ENV, "{}");
    const b = nodeSpawn({ graceMs: 200 })(program("b", `import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => {}); writeFileSync(${JSON.stringify(ignores)}, String(process.pid)); setInterval(() => {}, 1000);`), ENV, "{}");
    await waitFor("both programs to run", () => existsSync(listens) && existsSync(ignores) && readFileSync(listens, "utf8") !== "" && readFileSync(ignores, "utf8") !== "");
    const started = Date.now();
    a.stop("moot");
    a.stop("moot");
    expect(await a.done).toMatchObject({ ok: false, why: "stopped" });
    expect(Date.now() - started).toBeLessThan(2000);
    b.stop("moot");
    expect(alive(readPid(ignores))).toBe(true);
    expect(await b.done).toMatchObject({ ok: false, why: "stopped" });
    expect(alive(readPid(listens))).toBe(false);
    expect(alive(readPid(ignores))).toBe(false);
  });

  it("does not wait for a helper that keeps the output open after the program ended, and lets go of its pipes", async () => {
    const helperPid = join(dir, "helper-pid");
    const argv = program(
      "wrapper",
      `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
       const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
       helper.unref(); writeFileSync(${JSON.stringify(helperPid)}, String(helper.pid));
       process.stdout.write('{"answer":"approve"}\\n');`,
    );
    const started = Date.now();
    try {
      const result = await nodeSpawn({ drainMs: 150 })(argv, ENV, "{}").done;
      expect(result).toEqual({ ok: true, stdout: '{"answer":"approve"}\n', stderr: "" });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(alive(readPid(helperPid))).toBe(true);
    } finally {
      if (existsSync(helperPid)) {
        try {
          process.kill(readPid(helperPid), "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });

  it("signals the program's whole group while it runs, and never a group whose leader has been reaped", async () => {
    const leaderFile = join(dir, "leader");
    const helperFile = join(dir, "helper");
    const spawnsHelper = `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
       const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
       helper.unref(); writeFileSync(${JSON.stringify(helperFile)}, String(helper.pid)); writeFileSync(${JSON.stringify(leaderFile)}, String(process.pid));`;
    const stays = nodeSpawn({ graceMs: 3000 })(program("stays", `${spawnsHelper} setInterval(() => {}, 1000);`), ENV, "{}");
    await waitFor("the program and its helper", () => existsSync(leaderFile) && readFileSync(leaderFile, "utf8") !== "" && existsSync(helperFile) && readFileSync(helperFile, "utf8") !== "");
    const helper = readPid(helperFile);
    expect(alive(helper)).toBe(true);
    stays.stop("moot");
    expect(await stays.done).toMatchObject({ ok: false, why: "stopped" });
    await waitFor("the helper to end with its program", () => !alive(helper), 3000);

    // The program has ended on its own and left the helper: a stop now reaches nobody.
    rmSync(leaderFile);
    rmSync(helperFile);
    const leaves = nodeSpawn({ drainMs: 100 })(program("leaves", `${spawnsHelper} process.stdout.write('{"answer":"approve"}');`), ENV, "{}");
    try {
      expect(await leaves.done).toMatchObject({ ok: true });
      leaves.stop("moot");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(alive(readPid(helperFile))).toBe(true);
    } finally {
      try {
        process.kill(readPid(helperFile), "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  it("tells the program why by the signal: SIGTERM for a moot question, SIGINT when the broker is closing", async () => {
    const run = async (why: "moot" | "shutdown"): Promise<string> => {
      const ready = join(dir, `ready-${why}`);
      const got = join(dir, `got-${why}`);
      const argv = program(
        `signals-${why}`,
        `import { writeFileSync } from "node:fs";
         for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => { writeFileSync(${JSON.stringify(got)}, name); process.exit(0); });
         writeFileSync(${JSON.stringify(ready)}, "1"); setInterval(() => {}, 1000);`,
      );
      const child = nodeSpawn({ graceMs: 3000 })(argv, ENV, "{}");
      await waitFor("the program to run", () => existsSync(ready));
      child.stop(why);
      await child.done;
      return readFileSync(got, "utf8");
    };
    expect(await run("moot")).toBe("SIGTERM");
    expect(await run("shutdown")).toBe("SIGINT");
  });

  it("is not brought down by a program that never reads its input", async () => {
    const argv = program("deaf", `process.stdout.write('{"answer":"refuse"}');`);
    const result = await nodeSpawn()(argv, ENV, "x".repeat(1_000_000)).done;
    expect(result).toMatchObject({ ok: true });
  });
});

describe("the command approver in a broker", () => {
  const ask = { rules: [{ name: "ask-first", from: {}, to: {}, decision: "ask" }] };
  const SEND = { to_container: "beta", to_session: "b1", session: "a1", title: "Alpha one" };
  const timing = { retryFirstMs: 60, retryMaxMs: 120, maxChildren: 16 };
  const open: Harness[] = [];

  async function rig(approver: unknown, extra: { policy?: unknown; env?: Record<string, string>; dir?: string } = {}) {
    const h = await startHarness({
      policy: extra.policy ?? ask,
      approver,
      ...(extra.dir === undefined ? {} : { dir: extra.dir }),
      effects: { commandTiming: timing, spawn: nodeSpawn({ graceMs: 300 }), env: { PATH: process.env["PATH"], HOME: "/home/x", LANG: "C", BROKER_SECRET: "must-not-leak", ...extra.env } },
    });
    open.push(h);
    const a = await fakeAdapter(h, "alpha");
    const b = await fakeAdapter(h, "beta");
    await a.report("claude", [{ session: "a1", title: "Alpha one", activity: "idle" }]);
    await b.report("codex", [{ session: "b1", title: "Beta one", activity: "idle" }]);
    const alpha = await mcpClient(h, "alpha");
    return { h, a, b, alpha };
  }
  afterEach(async () => {
    for (const h of open.splice(0)) await h.close();
  });

  it("delivers a message its command approved, handing it the request and a clean environment", async () => {
    const seen = join(dir, "seen.json");
    const envFile = join(dir, "env.json");
    const argv = program(
      "yes",
      `import { writeFileSync } from "node:fs"; let s = ""; for await (const c of process.stdin) s += c; writeFileSync(${JSON.stringify(seen)}, s); writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env)); process.stdout.write('{"answer":"approve"}\\n');`,
    );
    const { a, b, alpha } = await rig({ kind: "command", argv, passEnv: ["PASSED_ON"], stateDir: join(dir, "state") }, { env: { PASSED_ON: "yes please" } });
    void a;
    const sent = await call(alpha, "send", { ...SEND, body: "hello beta" });
    expect(sent.json["state"]).toBe("held");
    const id = String(sent.json["id"]);
    await waitFor("the delivery after the command approved", () => b.deliveries.length === 1);
    expect(b.deliveries[0]?.id).toBe(id);
    expect(JSON.parse(readFileSync(seen, "utf8"))).toMatchObject({
      id,
      thread: id,
      hop: 0,
      from: { container: "alpha", product: "claude", session: "a1", title: "Alpha one" },
      to: { container: "beta", product: "codex", session: "b1" },
      body: "hello beta",
      rule: "ask-first",
    });
    expect(JSON.parse(readFileSync(envFile, "utf8"))).toEqual({
      PATH: process.env["PATH"],
      HOME: "/home/x",
      LANG: "C",
      PASSED_ON: "yes please",
      AGENT_GATEWAY_APPROVER_STATE_DIR: join(dir, "state"),
    });
  });

  it("refuses a message its command refused", async () => {
    const argv = program("no", `process.stdout.write('{"answer":"refuse"}');`);
    const { h, alpha } = await rig({ kind: "command", argv });
    const id = String((await call(alpha, "send", { ...SEND, body: "hello" })).json["id"]);
    await waitFor("the refusal", () => h.running.store.get(id)?.state === "refused");
    expect(h.running.store.get(id)).toMatchObject({ reason: { kind: "approver", answer: "no" } });
  });

  it("keeps a message held and tries again when the command gives no answer, with nothing of the body in the log", async () => {
    const runs = join(dir, "runs");
    const argv = program(
      "flaky",
      `import { appendFileSync, readFileSync } from "node:fs"; appendFileSync(${JSON.stringify(runs)}, "x"); let s = ""; for await (const c of process.stdin) s += c;
       const n = readFileSync(${JSON.stringify(runs)}, "utf8").length; if (n === 1) process.exit(1); if (n === 2) { process.stdout.write("garbage " + JSON.parse(s).body); process.exit(0); }
       process.stdout.write('{"answer":"approve"}');`,
    );
    const { h, b, alpha } = await rig({ kind: "command", argv });
    const id = String((await call(alpha, "send", { ...SEND, body: "TOPSECRETBODY" })).json["id"]);
    await waitFor("the third run to approve", () => b.deliveries.length === 1, 4000);
    expect(readFileSync(runs, "utf8")).toBe("xxx");
    expect(b.deliveries[0]?.id).toBe(id);
    expect(h.lines.filter((l) => l.includes("gave no answer"))).toHaveLength(2);
    expect(h.lines.join("\n")).not.toContain("TOPSECRETBODY");
  });

  it("stops the command at the deadline, by its PID, and the message is refused as unanswered", async () => {
    const pidFile = join(dir, "pid");
    const argv = program("hang", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
    const { h, alpha } = await rig({ kind: "command", argv }, { policy: { rules: ask.rules, limits: { approvalTtlMs: 400 } } });
    const id = String((await call(alpha, "send", { ...SEND, body: "late" })).json["id"]);
    await waitFor("the command to run", () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
    const pid = readPid(pidFile);
    expect(alive(pid)).toBe(true);
    await waitFor("the refusal at the deadline", () => h.running.store.get(id)?.state === "refused");
    expect(h.running.store.get(id)).toMatchObject({ reason: { kind: "approver", answer: "timeout" } });
    // It ignores SIGTERM, so the kill that ends it is the SIGKILL after the grace.
    await waitFor("the command to be gone", () => !alive(pid), 3000);
  });

  it("stops the command when a person answers from the command line, and the answer from the command line stands", async () => {
    const pidFile = join(dir, "pid");
    const argv = program("slow", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const { h, b, alpha } = await rig({ kind: "command", argv });
    const id = String((await call(alpha, "send", { ...SEND, body: "hello" })).json["id"]);
    await waitFor("the command to run", () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
    const pid = readPid(pidFile);
    const io = { out: () => undefined, err: () => undefined, now: () => Date.now() };
    expect(await runCli(["approve", id, "--config", h.configPath], {}, io)).toBe(0);
    await waitFor("the command to be stopped", () => !alive(pid));
    await waitFor("the delivery", () => b.deliveries.length === 1);
  });

  it("stops its commands when the broker closes", async () => {
    const pidFile = join(dir, "pid");
    const argv = program("slow", `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const { h, alpha } = await rig({ kind: "command", argv });
    await call(alpha, "send", { ...SEND, body: "hello" });
    await waitFor("the command to run", () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
    const pid = readPid(pidFile);
    await alpha.close();
    await h.close();
    open.length = 0;
    expect(alive(pid)).toBe(false);
  });

  it("runs the command again for the same id after a restart, so a command has to be idempotent by id", async () => {
    const state = join(dir, "broker");
    mkdirSync(state);
    const ids = join(dir, "ids");
    const argv = program(
      "noanswer",
      `import { appendFileSync } from "node:fs"; let s = ""; for await (const c of process.stdin) s += c; appendFileSync(${JSON.stringify(ids)}, JSON.parse(s).id + "\\n"); process.exit(1);`,
    );
    const first = await rig({ kind: "command", argv }, { dir: state });
    const id = String((await call(first.alpha, "send", { ...SEND, body: "hello" })).json["id"]);
    await waitFor("the first run", () => existsSync(ids));
    await first.alpha.close();
    await first.h.close();
    open.length = 0;
    const before = readFileSync(ids, "utf8").split("\n").filter(Boolean).length;

    const second = await rig({ kind: "command", argv }, { dir: state });
    await waitFor("the command to run again after the restart", () => readFileSync(ids, "utf8").split("\n").filter(Boolean).length > before);
    expect(new Set(readFileSync(ids, "utf8").split("\n").filter(Boolean))).toEqual(new Set([id]));
    // The question was not lost: it is still held, and the command line can answer it.
    expect(second.h.running.store.get(id)?.state).toBe("held");
  });
});
