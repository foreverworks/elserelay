import { readFileSync } from "node:fs";
import { z } from "zod";
import { MAX_DURATION_MS, parsePolicy } from "../core/policy.js";
import { PRODUCTS } from "../core/types.js";
import type { Policy, Product } from "../core/types.js";

const port = z.number().int().min(0).max(65_535);
const duration = z.number().int().min(1).max(MAX_DURATION_MS, { error: "must be at most 7 days (604800000 ms)" });

const approverConfig = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cli") }),
  z.strictObject({
    kind: z.literal("command"),
    /** The program and its arguments. Started directly, never through a shell. */
    argv: z.array(z.string().min(1)).min(1),
    /** Handed to the command as ELSERELAY_APPROVER_STATE_DIR, for what it keeps between runs. */
    stateDir: z.string().min(1).optional(),
    /** Names of variables of the broker's own environment that the command may see, besides PATH, HOME and LANG. */
    passEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
  }),
]);

const config = z.strictObject({
  /** The SQLite file. */
  store: z.string().min(1),
  /** A directory of `token-<container>` files, one per container. */
  tokensDir: z.string().min(1),
  listen: z.strictObject({
    host: z.string().min(1).default("127.0.0.1"),
    mcpPort: port,
    adapterPort: port,
    /** Host names the MCP door answers besides the loopback ones; needed when `host` is not a loopback address. */
    allowedHosts: z.array(z.string().min(1)).default([]),
  }),
  /** The token label of each container, and the one product it runs. The label is what a token proves. */
  containers: z.record(z.string().min(1), z.strictObject({ product: z.enum(PRODUCTS) })),
  /** How long a handed-out message may wait for its outcome before it goes back to the queue. */
  deliveryTimeoutMs: duration.default(60_000),
  /** How often the broker expires, retries, asks for approvals and pushes what waits. */
  pollMs: duration.default(1000),
  /** Who answers a held message besides the command line. Default: only the command line. */
  approver: approverConfig.default({ kind: "cli" }),
  policy: z.unknown().default({}),
  /** Google's terms forbid third party software on Antigravity, so a container that runs it needs this said out loud. */
  allowAntigravity: z.boolean().default(false),
});

export type ApproverConfig =
  | { readonly kind: "cli" }
  | { readonly kind: "command"; readonly argv: readonly string[]; readonly stateDir?: string; readonly passEnv: readonly string[] };

export type Config = {
  readonly store: string;
  readonly tokensDir: string;
  readonly listen: {
    readonly host: string;
    readonly mcpPort: number;
    readonly adapterPort: number;
    readonly allowedHosts: readonly string[];
  };
  /** Token label to product. */
  readonly products: ReadonlyMap<string, Product>;
  readonly deliveryTimeoutMs: number;
  readonly pollMs: number;
  readonly approver: ApproverConfig;
  readonly policy: Policy;
};

export type Parsed = { readonly ok: true; readonly config: Config } | { readonly ok: false; readonly problems: readonly string[] };

const commandOf = (a: Extract<z.output<typeof approverConfig>, { kind: "command" }>): ApproverConfig => ({
  kind: "command",
  argv: a.argv,
  ...(a.stateDir === undefined ? {} : { stateDir: a.stateDir }),
  passEnv: a.passEnv,
});

export function parseConfig(json: unknown): Parsed {
  const parsed = config.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => {
        const where = issue.path.map(String).join(".");
        return where === "" ? issue.message : `${where}: ${issue.message}`;
      }),
    };
  }
  const policy = parsePolicy(parsed.data.policy);
  if (!policy.ok) return { ok: false, problems: policy.problems.map((p) => `policy.${p}`) };

  const products = new Map<string, Product>(Object.entries(parsed.data.containers).map(([label, c]) => [label, c.product]));
  // A rule naming a container that does not exist would never match: almost always a typo, and a silent hole.
  const problems: string[] = [];
  policy.policy.rules.forEach((rule, index) => {
    for (const side of ["from", "to"] as const) {
      const name = rule[side].container;
      if (name !== undefined && !products.has(name)) {
        problems.push(`policy.rules.${index}.${side}.container: "${name}" is not in containers`);
      }
    }
  });
  // A policy, not a technical limit: see README.md, "Terms of the providers".
  if (!parsed.data.allowAntigravity) {
    for (const [label, product] of products) {
      if (product === "antigravity") {
        problems.push(`containers.${label}: antigravity is off unless allowAntigravity is true; read the provider's terms first`);
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const { listen } = parsed.data;
  return {
    ok: true,
    config: {
      store: parsed.data.store,
      tokensDir: parsed.data.tokensDir,
      listen: { host: listen.host, mcpPort: listen.mcpPort, adapterPort: listen.adapterPort, allowedHosts: listen.allowedHosts },
      products,
      deliveryTimeoutMs: parsed.data.deliveryTimeoutMs,
      pollMs: parsed.data.pollMs,
      approver: parsed.data.approver.kind === "cli" ? { kind: "cli" } : commandOf(parsed.data.approver),
      policy: policy.policy,
    },
  };
}

/** Reads and checks the file; the thrown message lists every problem and quotes none of the file. */
export function loadConfig(path: string): Config {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the config file ${path}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const result = parseConfig(json);
  if (!result.ok) throw new Error(`the config file ${path} has problems:\n${result.problems.map((p) => `  ${p}`).join("\n")}`);
  return result.config;
}
