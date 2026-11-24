import type { Limits, Reason } from "./types.js";

export type Measured = {
  /** The hop the new message would carry. */
  readonly hop: number;
  readonly bodyChars: number;
  /** Messages already sent by this pair of containers inside the window, not counting this one. */
  readonly sentInWindow: number;
};

/** The reason a refusal is not recorded: the sender's container is over its budget of refused messages. */
export function refusalsReason(limits: Limits, refusedInWindow: number): Reason | null {
  return refusedInWindow >= limits.refusals.messages ? { kind: "refusals", limit: limits.refusals.messages, windowMs: limits.refusals.windowMs } : null;
}

/** The first limit the message is over, or null. Reaching a limit is allowed; passing it is not. */
export function limitReason(limits: Limits, measured: Measured): Reason | null {
  if (measured.bodyChars > limits.maxBodyChars) return { kind: "too-long", limit: limits.maxBodyChars };
  if (measured.hop > limits.maxHops) return { kind: "hops", limit: limits.maxHops };
  if (measured.sentInWindow >= limits.rate.messages) {
    return { kind: "rate", limit: limits.rate.messages, windowMs: limits.rate.windowMs };
  }
  return null;
}
