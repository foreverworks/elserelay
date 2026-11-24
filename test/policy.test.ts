import { describe, expect, it } from "vitest";
import { decide, parsePolicy } from "../src/core/policy.js";
import type { Policy } from "../src/core/types.js";
import { addr } from "./fixtures.js";

const DEFAULT_LIMITS = {
  maxHops: 6,
  rate: { messages: 20, windowMs: 3_600_000 },
  maxBodyChars: 16_000,
  messageTtlMs: 86_400_000,
  approvalTtlMs: 900_000,
  maxAttempts: 5,
  refusals: { messages: 60, windowMs: 3_600_000 },
};

function parsed(json: unknown): Policy {
  const result = parsePolicy(json);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.policy;
}

function problems(json: unknown): readonly string[] {
  const result = parsePolicy(json);
  if (result.ok) throw new Error("expected problems");
  return result.problems;
}

describe("parsePolicy", () => {
  it("fills every limit default, also for an empty file", () => {
    expect(parsed({})).toEqual({ rules: [], limits: DEFAULT_LIMITS });
  });

  it("keeps given limits and defaults the rest, also inside rate", () => {
    const p = parsed({ limits: { maxHops: 2, rate: { messages: 3 } } });
    expect(p.limits).toEqual({ ...DEFAULT_LIMITS, maxHops: 2, rate: { messages: 3, windowMs: 3_600_000 } });
  });

  it("reads rules and leaves out what the file left out", () => {
    const p = parsed({
      rules: [
        { name: "a", from: { container: "x" }, to: {}, decision: "ask" },
        { name: "b", from: {}, to: { product: "codex" }, decision: "allow", wake: true },
      ],
    });
    expect(p.rules).toEqual([
      { name: "a", from: { container: "x" }, to: {}, decision: "ask" },
      { name: "b", from: {}, to: { product: "codex" }, decision: "allow", wake: true },
    ]);
    expect("wake" in (p.rules[0] ?? {})).toBe(false);
  });

  it("names the problem and its place", () => {
    expect(problems({ rules: [{ name: "a", from: {}, to: {}, decision: "maybe" }] })[0]).toMatch(/^rules\.0\.decision: /);
    expect(problems({ limits: { maxHops: -1 } })[0]).toMatch(/^limits\.maxHops: /);
    expect(problems({ limits: { rate: { messages: 0 } } })[0]).toMatch(/^limits\.rate\.messages: /);
    expect(problems({ limits: { maxAttempts: 1.5 } })[0]).toMatch(/^limits\.maxAttempts: /);
  });

  it("refuses unknown keys at every level", () => {
    expect(problems({ extra: 1 })).toHaveLength(1);
    expect(problems({ limits: { maxHop: 3 } })).toHaveLength(1);
    expect(problems({ limits: { rate: { count: 3 } } })).toHaveLength(1);
    expect(problems({ rules: [{ name: "a", from: {}, to: {}, decision: "allow", wakes: true }] })).toHaveLength(1);
    expect(problems({ rules: [{ name: "a", from: { session: "s" }, to: {}, decision: "allow" }] })).toHaveLength(1);
  });

  it("refuses a rule without from, to or a valid product", () => {
    expect(problems({ rules: [{ name: "a", to: {}, decision: "allow" }] }).length).toBeGreaterThan(0);
    expect(problems({ rules: [{ name: "a", from: {}, decision: "allow" }] }).length).toBeGreaterThan(0);
    expect(problems({ rules: [{ name: "a", from: { product: "gpt" }, to: {}, decision: "allow" }] }).length).toBeGreaterThan(0);
    expect(problems({ rules: [{ name: "", from: {}, to: {}, decision: "allow" }] }).length).toBeGreaterThan(0);
  });

  it("refuses duplicate rule names, pointing at the second", () => {
    const rule = { name: "same", from: {}, to: {}, decision: "allow" };
    expect(problems({ rules: [rule, rule] })).toEqual(['rules.1.name: rule name "same" is used twice']);
  });

  it("reports every problem, not only the first", () => {
    expect(problems({ extra: 1, limits: { maxHops: "x" }, rules: "no" }).length).toBeGreaterThanOrEqual(3);
  });

  it("refuses what is not an object", () => {
    for (const bad of [null, 3, "x", [], undefined]) expect(parsePolicy(bad).ok).toBe(false);
  });
});

describe("decide", () => {
  const policy = parsed({
    rules: [
      { name: "deny-mallory", from: { container: "mallory" }, to: {}, decision: "deny" },
      { name: "ask-codex", from: {}, to: { product: "codex" }, decision: "ask" },
      { name: "ab", from: { container: "a" }, to: { container: "b" }, decision: "allow", wake: true },
      { name: "any-b", from: {}, to: { container: "b" }, decision: "allow" },
    ],
  });

  it("the first match wins, even when a later rule also matches", () => {
    expect(decide(policy, addr("mallory"), addr("b"))).toEqual({ decision: "deny", rule: "deny-mallory", wake: false });
    expect(decide(policy, addr("a"), addr("b", "s", "codex"))).toEqual({ decision: "ask", rule: "ask-codex", wake: false });
  });

  it("allows with the rule's wake, which defaults to false", () => {
    expect(decide(policy, addr("a"), addr("b"))).toEqual({ decision: "allow", rule: "ab", wake: true });
    expect(decide(policy, addr("c"), addr("b"))).toEqual({ decision: "allow", rule: "any-b", wake: false });
  });

  it("no match is a denial with no rule and no wake", () => {
    expect(decide(policy, addr("c"), addr("d"))).toEqual({ decision: "deny", rule: null, wake: false });
    expect(decide(parsed({}), addr("a"), addr("b"))).toEqual({ decision: "deny", rule: null, wake: false });
  });

  it("matches the product and the container together, and ignores the session", () => {
    const p = parsed({ rules: [{ name: "r", from: { container: "a", product: "claude" }, to: {}, decision: "allow" }] });
    expect(decide(p, addr("a", "any", "claude"), addr("z")).decision).toBe("allow");
    expect(decide(p, addr("a", "any", "codex"), addr("z")).decision).toBe("deny");
    expect(decide(p, addr("b", "any", "claude"), addr("z")).decision).toBe("deny");
  });
});
