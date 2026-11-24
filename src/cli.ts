#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { escapeForTerminal, promptText } from "./broker/approver.js";
import { loadConfig } from "./broker/config.js";
import { realEffects, runBroker } from "./broker/main.js";
import { reasonText } from "./broker/reasons.js";
import { makeService } from "./broker/service.js";
import type { Address, AuditEntry } from "./core/types.js";
import { openStore } from "./store/sqlite.js";

const USAGE = `usage: agent-gateway <command> [--config <file>]

  broker             run the broker
  approvals          show the messages waiting for a yes or a no
  approve <id>       let a waiting message go
  refuse <id>        refuse a waiting message
  stop               hold every delivery, and refuse new messages
  start              resume after stop
  audit [--since <time>]   the log, from an ISO time (default: the last day)

The config file is --config, or the AGENT_GATEWAY_CONFIG variable.`;

export type Io = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly now: () => number;
};

const place = (a: Address): string => escapeForTerminal(`${a.container}/${a.session}`).replace(/\n/g, " ");

function auditLine(entry: AuditEntry): string {
  const detail = entry.detail === null ? "" : ` (${reasonText(entry.detail)})`;
  return `${new Date(entry.at).toISOString()} ${entry.event} ${entry.state} ${place(entry.from)} -> ${place(entry.to)} ${entry.message}${detail}`;
}

/** Returns the exit code. */
export async function runCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: { config: { type: "string" }, since: { type: "string" } } });
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : "bad arguments"}\n${USAGE}`);
    return 2;
  }
  const [command, id, ...rest] = parsed.positionals;
  const configPath = parsed.values.config ?? env["AGENT_GATEWAY_CONFIG"];
  if (command === undefined || rest.length > 0 || configPath === undefined || configPath === "") {
    io.err(USAGE);
    return 2;
  }

  try {
    if (command === "broker") {
      await runBroker(configPath, { ...realEffects, now: io.now });
      return 0;
    }
    const config = loadConfig(configPath);
    const store = openStore(config.store);
    try {
      const service = makeService({
        store,
        policy: config.policy,
        products: config.products,
        now: io.now,
        newId: () => randomUUID(),
        deliveryTimeoutMs: config.deliveryTimeoutMs,
      });
      const stamp = (): string => new Date(io.now()).toISOString();

      switch (command) {
        case "approvals": {
          const waiting = service.approvals();
          io.out(waiting.length === 0 ? "nothing is waiting" : waiting.map(promptText).join("\n\n"));
          return 0;
        }
        case "approve":
        case "refuse": {
          if (id === undefined) {
            io.err(USAGE);
            return 2;
          }
          const answered = command === "approve" ? service.approve(id) : service.refuse(id);
          if (!answered.ok) {
            io.err(answered.why === "not-found" ? `no message ${id}` : `message ${id} is not waiting for an answer`);
            return 1;
          }
          io.out(`${command === "approve" ? "approved" : "refused"} ${id}`);
          return 0;
        }
        case "stop":
        case "start":
          store.setStopped(command === "stop", io.now());
          io.err(`${stamp()} ${command === "stop" ? "stopped: deliveries are held and new messages are refused" : "started: deliveries resume"}`);
          return 0;
        case "audit": {
          const since = parsed.values.since === undefined ? io.now() - 86_400_000 : Date.parse(parsed.values.since);
          if (Number.isNaN(since)) {
            io.err("--since needs a time such as 2026-11-24T09:00:00Z");
            return 2;
          }
          store.audit(since).forEach((entry) => io.out(auditLine(entry)));
          return 0;
        }
        default:
          io.err(USAGE);
          return 2;
      }
    } finally {
      store.close();
    }
  } catch (error) {
    io.err(error instanceof Error ? error.message : "failed");
    return 1;
  }
}

// Only when run as the program, not when a test imports it.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    now: () => Date.now(),
  }).then((code) => {
    process.exitCode = code;
  });
}
