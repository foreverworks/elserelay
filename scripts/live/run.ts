/** What every live run needs around its scenarios: a run folder, a report, a turn budget, the broker and the adapters, and a clean stop. */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenFile } from "./tokens.ts";
import { sleep, until } from "./util.ts";

export type Verdict = { readonly n: number; readonly name: string; readonly result: "pass" | "fail" | "not run"; readonly evidence: string };

export type Report = {
  readonly line: (text: string) => void;
  /** Records a scenario's verdict and prints it. */
  readonly done: (n: number, name: string, result: Verdict["result"], evidence: string) => void;
  readonly verdicts: Verdict[];
};

/** `mask` hides what must not reach a log, such as session ids. */
export function createReport(dir: string, mask: (text: string) => string): Report {
  const verdicts: Verdict[] = [];
  const line = (text: string): void => {
    const masked = mask(text);
    console.log(masked);
    appendFileSync(join(dir, "report.txt"), `${masked}\n`);
  };
  return {
    line,
    verdicts,
    done: (n, name, result, evidence) => {
      const v = { n, name, result, evidence: mask(evidence) };
      verdicts.push(v);
      line(`(${n}) ${result.toUpperCase()}: ${name}\n    ${v.evidence}`);
    },
  };
}

export type Budget = {
  readonly count: () => number;
  /** Call for each model turn, from either product. */
  readonly onTurn: () => void;
  /** Throws once more turns than the limit were taken. */
  readonly check: () => void;
  readonly over: () => Error | null;
};

export function createBudget(max: number): Budget {
  let taken = 0;
  let over: Error | null = null;
  return {
    count: () => taken,
    onTurn: () => {
      taken += 1;
      if (taken > max) over = new Error(`more than ${max} model turns were taken: stopping`);
    },
    check: () => {
      if (over !== null) throw over;
    },
    over: () => over,
  };
}

/** A run folder (mode 0700) named after the time, with a private working directory and the given extra folders. */
export function createRunDir(base: string, prefix: string, extra: readonly string[]): { dir: string; stamp: string; work: string; tokensDir: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(base, `${prefix}-${stamp}`);
  const work = join(dir, "empty");
  const tokensDir = join(dir, "tokens");
  for (const d of [dir, work, tokensDir, ...extra.map((e) => join(dir, e))]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return { dir, stamp, work, tokensDir };
}

export type Ports = { readonly mcpPort: number; readonly adapterPort: number };

export function writeBrokerConfig(path: string, dir: string, tokensDir: string, ports: Ports, containers: Record<string, { product: string }>, rules: readonly object[]): void {
  writeFileSync(
    path,
    JSON.stringify({
      store: join(dir, "broker.sqlite"),
      tokensDir,
      listen: { host: "127.0.0.1", mcpPort: ports.mcpPort, adapterPort: ports.adapterPort },
      containers,
      pollMs: 500,
      policy: { rules },
    }),
    { mode: 0o600 },
  );
}

/** Starts the broker and waits until `answers` says it does. */
export async function startBroker(cli: string, config: string, work: string, dir: string, children: ChildProcess[], answers: () => Promise<boolean>): Promise<void> {
  const broker = spawn(process.execPath, [cli, "broker", "--config", config], { cwd: work, stdio: ["ignore", "ignore", "pipe"] });
  children.push(broker);
  broker.stderr.pipe(createWriteStream(join(dir, "broker.log")));
  await until("the broker to answer", 15_000, answers);
}

export type AdapterOptions = {
  readonly cli: string;
  readonly cwd: string;
  readonly dir: string;
  readonly tokensDir: string;
  readonly adapterPort: number;
  readonly label: string;
  readonly product: "claude" | "codex";
  readonly sessions: string;
  readonly stateDir: string;
  /** Extra environment, such as CODEX_SOCKET. */
  readonly env?: Record<string, string>;
  readonly children: ChildProcess[];
};

export function spawnAdapter(o: AdapterOptions): ChildProcess {
  const child = spawn(process.execPath, [o.cli, "adapter"], {
    cwd: o.cwd,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      GATEWAY_URL: `http://127.0.0.1:${o.adapterPort}`,
      GATEWAY_TOKEN_FILE: tokenFile(o.tokensDir, o.label),
      GATEWAY_PRODUCT: o.product,
      GATEWAY_STATE_DIR: o.stateDir,
      GATEWAY_SESSIONS: o.sessions,
      ...o.env,
    },
  });
  child.stderr.pipe(createWriteStream(join(o.dir, `adapter-${o.label}.log`), { flags: "a" }));
  o.children.push(child);
  return child;
}

/** Signals only the processes this run started, first politely and then not. */
export async function stopChildren(children: readonly ChildProcess[]): Promise<void> {
  for (const child of children) if (child.exitCode === null && child.pid !== undefined) child.kill("SIGTERM");
  await sleep(3000);
  for (const child of children) if (child.exitCode === null && child.pid !== undefined) child.kill("SIGKILL");
}

/** Runs a scenario's body, records a pass or fail with its evidence, and lets a budget overrun end the run. */
export function createScenarios(report: Report, budget: Budget): (n: number, name: string, body: () => Promise<{ ok: boolean; evidence: string }>) => Promise<void> {
  return async (n, name, body) => {
    try {
      const r = await body();
      report.done(n, name, r.ok ? "pass" : "fail", r.evidence);
    } catch (error) {
      report.done(n, name, "fail", error instanceof Error ? error.message : "failed");
      const over = budget.over();
      if (over !== null) throw over;
    }
  };
}

/** Waits until `signature` has stopped changing for `quietMs`, for at most `maxMs`. */
export async function settle(signature: () => Promise<string>, check: () => void, quietMs: number, maxMs: number): Promise<void> {
  const end = Date.now() + maxMs;
  let last = "";
  let since = Date.now();
  while (Date.now() < end) {
    check();
    const now = await signature();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since > quietMs) return;
    await sleep(1000);
  }
}
