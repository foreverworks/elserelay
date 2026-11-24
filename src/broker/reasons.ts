import { oneLine } from "../core/render.js";
import type { Reason } from "../core/types.js";

/** A reason in words the sender (a model) can act on. */
export function reasonText(reason: Reason): string {
  switch (reason.kind) {
    case "policy":
      return reason.rule === null
        ? "no policy rule lets you message that session"
        : `the policy rule "${oneLine(reason.rule)}" does not let you message that session`;
    case "approver":
      return reason.answer === "no" ? "a person refused it" : "no person answered in time";
    case "hops":
      return reason.sendWindowMs === undefined
        ? `this thread already has ${reason.limit} replies, the most allowed`
        : `this session was answering a recent message from that container, and a chain of messages may not pass ${reason.limit}; this is not a limit on a thread of yours. For a new topic, wait ${Math.ceil(reason.sendWindowMs / 60_000)} minutes after that message`;
    case "rate":
      return `more than ${reason.limit} messages between these containers within ${Math.round(reason.windowMs / 60_000)} minutes`;
    case "stopped":
      return "the gateway is stopped; try again later";
    case "cold":
      return "the session is not active and waking it is not allowed";
    case "unknown-peer":
      return "no such session is listed; call list_peers";
    case "too-long":
      return `the message is longer than ${reason.limit} characters`;
    case "no-outcome":
      return `the receiving product did not say within ${Math.round(reason.ms / 1000)} seconds whether it took the message`;
    case "refusals":
      return `too many of your messages were refused (more than ${reason.limit} within ${Math.round(reason.windowMs / 60_000)} minutes), so this one was not recorded`;
    case "driver":
      return `the receiving product could not take it: ${oneLine(reason.detail)}`;
  }
}

/**
 * The reason as the sender reads it. A policy refusal never names its rule: the rule is the operator's to know, and a sender that could
 * read it would learn the policy one probe at a time. An unknown container is answered the same way, so it cannot be told apart from a
 * container the sender may not reach.
 */
export function senderText(reason: Reason): string {
  return reason.kind === "policy" ? "no policy rule lets you message that session" : reasonText(reason);
}
