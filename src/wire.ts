/**
 * What an adapter and the broker say to each other, over HTTP, both sides
 * opened by the adapter with its container's bearer token:
 *
 *   GET  /adapter/stream    server-sent events, each `data:` a `ToAdapter`
 *   POST /adapter/report    an `AdapterReport`; answered 204
 *   POST /adapter/outcome   an `Outcome`; answered 204, also when it is a repeat
 *   POST /adapter/inbox     an `InboxRequest`; answered 200 with an `InboxAnswer`
 *
 * The container is never in a body: it is what the token names.
 */
import type { Address, Product } from "./core/types.js";
import type { Capabilities, Delivered, Seen } from "./drivers/driver.js";

export const STREAM_PATH = "/adapter/stream";
export const REPORT_PATH = "/adapter/report";
export const OUTCOME_PATH = "/adapter/outcome";
export const INBOX_PATH = "/adapter/inbox";

/** The whole list, every time: a session missing from it is gone. */
export type AdapterReport = {
  readonly product: Product;
  readonly capabilities: Capabilities;
  readonly sessions: readonly Seen[];
};

export type ToAdapter =
  | { readonly kind: "deliver"; readonly id: string; readonly attempt: number; readonly to: Address; readonly text: string }
  | { readonly kind: "ping" };

export type Outcome = {
  readonly id: string;
  readonly attempt: number;
  readonly result: Delivered;
};

/**
 * The pull path, for a product that has a hook but no way to be pushed to: the
 * same service call as the MCP `inbox` tool. What it hands out is not yet
 * delivered. The caller names the ids it has read in `received` on its next
 * call (or alone, with `acknowledgeOnly`, which hands out nothing); what is not
 * named comes back after the broker's delivery timeout.
 */
export type InboxRequest = {
  readonly session: string;
  readonly received?: readonly string[];
  readonly acknowledgeOnly?: boolean;
};
export type InboxAnswer = { readonly messages: readonly { readonly id: string; readonly text: string }[] };
