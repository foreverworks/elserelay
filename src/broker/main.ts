import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadTokens, serve } from "@foreverworks/mcp-kit";
import { openStore } from "../store/sqlite.js";
import type { Store } from "../store/types.js";
import { cliApprover } from "./approver.js";
import type { Approver } from "./approver.js";
import { makeCommandApprover } from "./command.js";
import type { After, Spawn, Timing } from "./command.js";
import { listen, makeChannel } from "./channel.js";
import type { Every } from "./channel.js";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { makeService } from "./service.js";
import type { Service } from "./service.js";
import { nodeSpawn } from "./spawn.js";
import { INSTRUCTIONS, POLICY, registerTools } from "./tools.js";

/** What a running broker is made of, with every effect handed in. */
export type Effects = {
  readonly now: () => number;
  readonly newId: () => string;
  readonly every: Every;
  readonly log: (line: string) => void;
  /** Replaces the approver the config asks for. */
  readonly approver?: Approver;
  /** The environment a command approver's program is built from. Defaults to the process's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly spawn?: Spawn;
  readonly after?: After;
  readonly commandTiming?: Timing;
};

export const realEffects: Effects = {
  now: () => Date.now(),
  newId: () => randomUUID(),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
  log: (line) => process.stderr.write(`${line}\n`),
};

const realAfter: After = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export type Running = {
  readonly mcpPort: number;
  readonly adapterPort: number;
  readonly store: Store;
  readonly service: Service;
  readonly close: () => Promise<void>;
};

// Both the source and the built file sit two folders below the package root.
const version = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string" ? pkg.version : "0.0.0";
};

/** The environment `serve` reads, built from the config so nothing of the process's own leaks in. */
function mcpEnv(config: Config): NodeJS.ProcessEnv {
  const { listen: where } = config;
  return {
    MCP_HTTP_PORT: String(where.mcpPort),
    MCP_HTTP_TOKENS_DIR: config.tokensDir,
    MCP_HTTP_HOST: where.host,
    ...(where.allowedHosts.length > 0 ? { MCP_HTTP_ALLOWED_HOSTS: where.allowedHosts.join(",") } : {}),
  };
}

export async function startBroker(config: Config, effects: Effects): Promise<Running> {
  const { log } = effects;
  const store = openStore(config.store);
  const service = makeService({
    store,
    policy: config.policy,
    products: config.products,
    now: effects.now,
    newId: effects.newId,
    deliveryTimeoutMs: config.deliveryTimeoutMs,
  });

  const approver =
    effects.approver ??
    (config.approver.kind === "command"
      ? makeCommandApprover({
          argv: config.approver.argv,
          ...(config.approver.stateDir === undefined ? {} : { stateDir: config.approver.stateDir }),
          passEnv: config.approver.passEnv,
          env: effects.env ?? process.env,
          service,
          spawn: effects.spawn ?? nodeSpawn(),
          after: effects.after ?? realAfter,
          now: effects.now,
          log,
          ...(effects.commandTiming === undefined ? {} : { timing: effects.commandTiming }),
        })
      : cliApprover(log));

  const tokens = await loadTokens({ kind: "dir", dir: config.tokensDir });
  for (const label of tokens.keys()) {
    if (!config.products.has(label)) log(`the token for "${label}" has no entry in containers, so it is refused everywhere`);
  }

  const channel = makeChannel({ service, tokens, every: effects.every });
  const adapters = await listen(channel, config.listen.host, config.listen.adapterPort);

  const mcp = await serve({
    name: "agent-gateway",
    version: version(),
    instructions: INSTRUCTIONS,
    register: registerTools(service, channel.pump),
    policy: POLICY,
    env: mcpEnv(config),
    log,
  });

  const asked = new Set<string>();
  const poll = (): void => {
    try {
      service.tick();
      const held = service.approvals();
      // A message that left the held state may come back (a rule that now asks), and then it is asked about again.
      const heldIds = new Set(held.map((request) => request.id));
      for (const id of [...asked]) if (!heldIds.has(id)) asked.delete(id);
      approver.sync?.(heldIds);
      for (const request of held) {
        if (asked.has(request.id)) continue;
        asked.add(request.id);
        approver.ask(request).catch((error: unknown) => log(`the approver failed for ${request.id}: ${error instanceof Error ? error.message : "unknown error"}`));
      }
      channel.pumpAll();
    } catch (error) {
      log(`poll failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };
  poll();
  const stopPolling = effects.every(config.pollMs, poll);

  return {
    mcpPort: mcp.port ?? config.listen.mcpPort,
    adapterPort: adapters.port,
    store,
    service,
    close: async () => {
      stopPolling();
      await approver.close?.();
      await adapters.close();
      await mcp.close();
      store.close();
    },
  };
}

/** Runs until SIGTERM or SIGINT. */
export async function runBroker(configPath: string, effects: Effects = realEffects): Promise<void> {
  const config = loadConfig(configPath);
  const running = await startBroker(config, effects);
  effects.log(`agent-gateway: MCP on ${config.listen.host}:${running.mcpPort}, adapters on ${config.listen.host}:${running.adapterPort}`);
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  await running.close();
}
