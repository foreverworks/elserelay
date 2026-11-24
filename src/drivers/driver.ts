/**
 * What an adapter needs from a product. A driver holds no policy and no state
 * it could not rebuild: it finds sessions and hands text over.
 */
import type { Certainty, Peer, Product } from "../core/types.js";

/** A session as the driver sees it. The container and the time are the adapter's and the broker's to add. */
export type Seen = Omit<Peer, "container" | "seenAt" | "product">;

export type Capabilities = {
  /** Whether `deliver` reaches a session that is open, without the session asking for it. */
  readonly push: boolean;
  /** Whether a delivery starts a turn in an idle session. */
  readonly wakesIdle: boolean;
  /** Whether a delivery can join a turn that is running. */
  readonly joinsTurn: boolean;
  /** The most a successful `deliver` can claim. */
  readonly certainty: Certainty;
};

export type Delivered =
  | { readonly ok: true; readonly certainty: Certainty }
  /** `retry` false: trying again cannot help (the session is gone, the product refused). */
  | { readonly ok: false; readonly retry: boolean; readonly detail: string };

export type Driver = {
  readonly product: Product;
  readonly capabilities: () => Capabilities;
  readonly list: () => Promise<readonly Seen[]>;
  /** Null when the session is not there. */
  readonly status: (session: string) => Promise<Seen | null>;
  /** `text` is already rendered with its provenance; a driver passes it on unchanged. */
  readonly deliver: (session: string, text: string) => Promise<Delivered>;
};
