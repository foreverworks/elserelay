import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/broker/config.js";

const base = {
  store: "/var/lib/agw/broker.sqlite",
  tokensDir: "/run/agw/tokens",
  listen: { mcpPort: 7410, adapterPort: 7411 },
  containers: { alpha: { product: "claude" }, beta: { product: "codex" } },
};

const problems = (json: unknown): readonly string[] => {
  const r = parseConfig(json);
  if (r.ok) throw new Error("expected problems");
  return r.problems;
};

describe("parseConfig", () => {
  it("binds the product to each container and fills the defaults", () => {
    const r = parseConfig({ ...base, policy: { rules: [{ name: "r", from: { container: "alpha" }, to: {}, decision: "allow" }] } });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.config.products.get("alpha")).toBe("claude");
    expect(r.config.products.get("beta")).toBe("codex");
    expect(r.config.listen).toEqual({ host: "127.0.0.1", mcpPort: 7410, adapterPort: 7411, allowedHosts: [] });
    expect(r.config.deliveryTimeoutMs).toBe(60_000);
    expect(r.config.pollMs).toBe(1000);
    expect(r.config.policy.rules).toHaveLength(1);
    expect(r.config.policy.limits.maxHops).toBe(6);
  });

  it("accepts an empty policy, which refuses everything", () => {
    const r = parseConfig(base);
    expect(r.ok && r.config.policy.rules).toEqual([]);
  });

  it("is strict: unknown keys, unknown products and missing parts are named", () => {
    expect(problems({ ...base, extra: 1 })).toEqual(["Unrecognized key: \"extra\""]);
    expect(problems({ ...base, containers: { alpha: { product: "gpt" } } })[0]).toContain("containers.alpha.product");
    expect(problems({ ...base, containers: { alpha: { product: "claude", more: true } } })[0]).toContain("containers.alpha");
    expect(problems({ ...base, listen: { mcpPort: 1 } })[0]).toContain("listen.adapterPort");
    expect(problems({ ...base, store: undefined })[0]).toContain("store");
  });

  it("names the policy's problems under policy", () => {
    expect(problems({ ...base, policy: { rules: [{ name: "r", from: {}, to: {}, decision: "maybe" }] } })[0]).toMatch(/^policy\.rules\.0\.decision/);
  });

  it("refuses a rule that names a container that is not configured", () => {
    expect(problems({ ...base, policy: { rules: [{ name: "r", from: { container: "alpa" }, to: {}, decision: "allow" }] } })).toEqual([
      'policy.rules.0.from.container: "alpa" is not in containers',
    ]);
  });
});

describe("the approver section", () => {
  const withApprover = (approver: unknown) => parseConfig({ ...base, approver });

  it("is the command line when left out", () => {
    const r = parseConfig(base);
    expect(r.ok && r.config.approver).toEqual({ kind: "cli" });
    expect(withApprover({ kind: "cli" }).ok).toBe(true);
  });

  it("takes a command with its arguments, an optional state directory and the names to pass through", () => {
    const r = withApprover({ kind: "command", argv: ["agent-gateway", "approver", "elsewire"], stateDir: "/data/approver", passEnv: ["ELSEWIRE_URL"] });
    expect(r.ok && r.config.approver).toEqual({ kind: "command", argv: ["agent-gateway", "approver", "elsewire"], stateDir: "/data/approver", passEnv: ["ELSEWIRE_URL"] });
    const bare = withApprover({ kind: "command", argv: ["/usr/local/bin/ask"] });
    expect(bare.ok && bare.config.approver).toEqual({ kind: "command", argv: ["/usr/local/bin/ask"], passEnv: [] });
  });

  it("refuses an empty command, an empty program, a bad variable name, other kinds and stray keys", () => {
    expect(problems({ ...base, approver: { kind: "command", argv: [] } })[0]).toContain("approver.argv");
    expect(problems({ ...base, approver: { kind: "command", argv: [""] } })[0]).toContain("approver.argv");
    expect(problems({ ...base, approver: { kind: "command", argv: ["x"], passEnv: ["A=B"] } })[0]).toContain("approver.passEnv");
    expect(problems({ ...base, approver: { kind: "email" } })[0]).toContain("approver");
    expect(problems({ ...base, approver: { kind: "command", argv: ["x"], shell: true } })[0]).toContain("approver");
    expect(problems({ ...base, approver: { kind: "cli", argv: ["x"] } })[0]).toContain("approver");
  });
});

describe("loadConfig", () => {
  it("reads a file, and an error lists the problems without quoting the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agw-config-"));
    try {
      const good = join(dir, "good.json");
      writeFileSync(good, JSON.stringify(base));
      expect(loadConfig(good).store).toBe(base.store);
      const bad = join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify({ ...base, tokensDir: 5, secret: "s3cret-value" }));
      expect(() => loadConfig(bad)).toThrow(/tokensDir/);
      expect(() => loadConfig(bad)).not.toThrow(/s3cret-value/);
      expect(() => loadConfig(join(dir, "missing.json"))).toThrow(/cannot read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
