import { z } from "zod";
import { PRODUCTS } from "./types.js";
import type { Address, Decision, Match, Policy, Rule } from "./types.js";

const match = z.strictObject({
  container: z.string().min(1).optional(),
  product: z.enum(PRODUCTS).optional(),
});

const rule = z.strictObject({
  name: z.string().min(1),
  from: match,
  to: match,
  decision: z.enum(["allow", "deny", "ask"]),
  wake: z.boolean().optional(),
});

const count = z.number().int().min(1);

/** The longest wait a timer is given: a longer one would pass what a timer can hold (about 24.8 days) and fire at once. */
export const MAX_DURATION_MS = 7 * 86_400_000;
const duration = z.number().int().min(1).max(MAX_DURATION_MS, { error: "must be at most 7 days (604800000 ms)" });

// `prefault` feeds the empty object through the field defaults, so a file may leave out any part of `limits`.
const limits = z
  .strictObject({
    maxHops: z.number().int().min(0).default(6),
    rate: z
      .strictObject({ messages: count.default(20), windowMs: count.default(3_600_000) })
      .prefault({}),
    maxBodyChars: count.default(16_000),
    messageTtlMs: count.default(86_400_000),
    approvalTtlMs: duration.default(900_000),
    maxAttempts: count.default(5),
    refusals: z
      .strictObject({ messages: count.default(60), windowMs: count.default(3_600_000) })
      .prefault({}),
  })
  .prefault({});

const policy = z
  .strictObject({ rules: z.array(rule).default([]), limits })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.rules.forEach((r, index) => {
      if (seen.has(r.name)) {
        ctx.addIssue({ code: "custom", path: ["rules", index, "name"], message: `rule name "${r.name}" is used twice` });
      }
      seen.add(r.name);
    });
  });

type ParsedMatch = z.output<typeof match>;

// Zod types an absent key as `T | undefined`; the shared types forbid that under exactOptionalPropertyTypes.
function toMatch(m: ParsedMatch): Match {
  return {
    ...(m.container === undefined ? {} : { container: m.container }),
    ...(m.product === undefined ? {} : { product: m.product }),
  };
}

export function parsePolicy(json: unknown): { readonly ok: true; readonly policy: Policy } | { readonly ok: false; readonly problems: readonly string[] } {
  const parsed = policy.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => {
        const where = issue.path.map(String).join(".");
        return where === "" ? issue.message : `${where}: ${issue.message}`;
      }),
    };
  }
  const rules: readonly Rule[] = parsed.data.rules.map((r) => ({
    name: r.name,
    from: toMatch(r.from),
    to: toMatch(r.to),
    decision: r.decision,
    ...(r.wake === undefined ? {} : { wake: r.wake }),
  }));
  return { ok: true, policy: { rules, limits: parsed.data.limits } };
}

function matches(pattern: Match, address: Address): boolean {
  return (
    (pattern.container === undefined || pattern.container === address.container) &&
    (pattern.product === undefined || pattern.product === address.product)
  );
}

/** First matching rule decides; no match is a refusal. */
export function decide(
  policy: Policy,
  from: Address,
  to: Address,
): { readonly decision: Decision; readonly rule: string | null; readonly wake: boolean } {
  const found = policy.rules.find((r) => matches(r.from, from) && matches(r.to, to));
  if (found === undefined) return { decision: "deny", rule: null, wake: false };
  return { decision: found.decision, rule: found.name, wake: found.wake ?? false };
}
