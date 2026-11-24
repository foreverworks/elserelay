import { describe, expect, it } from "vitest";
import { limitReason } from "../src/core/limits.js";
import type { Limits } from "../src/core/types.js";

const limits: Limits = {
  maxHops: 6,
  rate: { messages: 20, windowMs: 3_600_000 },
  maxBodyChars: 100,
  messageTtlMs: 1,
  approvalTtlMs: 1,
  maxAttempts: 5,
};
const ok = { hop: 0, bodyChars: 1, sentInWindow: 0 };

describe("limitReason", () => {
  it("lets a message through that is under every limit", () => {
    expect(limitReason(limits, ok)).toBeNull();
  });

  it("hops: the limit itself is allowed, one more is refused", () => {
    expect(limitReason(limits, { ...ok, hop: 6 })).toBeNull();
    expect(limitReason(limits, { ...ok, hop: 7 })).toEqual({ kind: "hops", limit: 6 });
  });

  it("body: the limit itself is allowed, one more is refused", () => {
    expect(limitReason(limits, { ...ok, bodyChars: 100 })).toBeNull();
    expect(limitReason(limits, { ...ok, bodyChars: 101 })).toEqual({ kind: "too-long", limit: 100 });
  });

  it("rate: one below the limit is allowed, the limit already sent is refused", () => {
    expect(limitReason(limits, { ...ok, sentInWindow: 19 })).toBeNull();
    expect(limitReason(limits, { ...ok, sentInWindow: 20 })).toEqual({ kind: "rate", limit: 20, windowMs: 3_600_000 });
    expect(limitReason(limits, { ...ok, sentInWindow: 500 })).toEqual({ kind: "rate", limit: 20, windowMs: 3_600_000 });
  });

  it("reports the length first, then hops, then rate", () => {
    const all = { hop: 99, bodyChars: 999, sentInWindow: 99 };
    expect(limitReason(limits, all)?.kind).toBe("too-long");
    expect(limitReason(limits, { ...all, bodyChars: 1 })?.kind).toBe("hops");
    expect(limitReason(limits, { ...all, bodyChars: 1, hop: 0 })?.kind).toBe("rate");
  });
});
