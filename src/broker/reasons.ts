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
      return `this thread already has ${reason.limit} replies, the most allowed`;
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
    case "driver":
      return `the receiving product could not take it: ${oneLine(reason.detail)}`;
  }
}
