/**
 * The vocabulary every part shares. Types only: the rules over them are in
 * `states.ts`, `policy.ts` and `limits.ts`.
 *
 * Times are milliseconds since the epoch, always passed in, never read here.
 */

export const PRODUCTS = ["claude", "codex", "antigravity", "fake"] as const;
export type Product = (typeof PRODUCTS)[number];

/** A session as an adapter reports it. `container` comes from the adapter's token; the rest is the adapter's claim. */
export type Peer = {
  readonly container: string;
  readonly product: Product;
  readonly session: string;
  readonly title: string | null;
  readonly activity: "idle" | "busy" | "cold" | "unknown";
  readonly seenAt: number;
};

/** One end of a message: a session of a container. */
export type Address = {
  readonly container: string;
  readonly product: Product;
  readonly session: string;
};

/** What the broker knows of the sender: the container is enforced by its token, the session is claimed. */
export type Sender = Address & { readonly title: string | null };

export type Message = {
  readonly id: string;
  readonly thread: string;
  /** 0 for a thread's first message, one more for each reply. */
  readonly hop: number;
  readonly replyTo: string | null;
  readonly from: Sender;
  readonly to: Address;
  /** Empty once the message is refused: a refused message keeps only the length and hash below. */
  readonly body: string;
  /** Characters and SHA-256 of the body as it was sent, kept after a refusal wipes the text. */
  readonly bodyChars: number;
  readonly bodySha256: string;
  readonly createdAt: number;
  readonly expiresAt: number;
};

export const STATES = ["received", "held", "queued", "delivering", "delivered", "refused", "expired"] as const;
export type State = (typeof STATES)[number];

/** How sure a driver is that the product has the message: it answered, or it only took the bytes. */
export type Certainty = "confirmed" | "accepted";

/** Why a message was refused or is waiting. Each is shown to the sender. */
export type Reason =
  | { readonly kind: "policy"; readonly rule: string | null }
  | { readonly kind: "approver"; readonly answer: "no" | "timeout" | "too-long" }
  /** `sendWindowMs` is set when a `send` was stopped: the count came from a message its session was handed within that time. */
  | { readonly kind: "hops"; readonly limit: number; readonly sendWindowMs?: number }
  | { readonly kind: "rate"; readonly limit: number; readonly windowMs: number }
  | { readonly kind: "stopped" }
  | { readonly kind: "cold" }
  | { readonly kind: "unknown-peer" }
  | { readonly kind: "too-long"; readonly limit: number }
  /** A handed-out message whose adapter never reported what happened to it. */
  | { readonly kind: "no-outcome"; readonly ms: number }
  /** The sender's container has had too many messages refused, so this one was not even recorded. */
  | { readonly kind: "refusals"; readonly limit: number; readonly windowMs: number }
  | { readonly kind: "driver"; readonly detail: string };

/** What happened to a message, as `states.ts` takes it. */
export type Event =
  | { readonly kind: "refuse"; readonly reason: Reason }
  | { readonly kind: "hold" }
  | { readonly kind: "approve" }
  | { readonly kind: "queue" }
  | { readonly kind: "hand-out"; readonly attempt: number }
  /** The receiving session fetched it through `inbox`; it does not count as an attempt. */
  | { readonly kind: "pull" }
  | { readonly kind: "deliver"; readonly certainty: Certainty }
  | { readonly kind: "retry"; readonly reason: Reason }
  | { readonly kind: "expire" };

export type Tracked = {
  readonly message: Message;
  readonly state: State;
  readonly attempts: number;
  /** In `delivering`: whether the session pulled it, so only its own acknowledgement or expiry ends it, and no timeout retries it. */
  readonly pulled: boolean;
  readonly reason: Reason | null;
  readonly certainty: Certainty | null;
  readonly updatedAt: number;
};

export type Decision = "allow" | "deny" | "ask";

/** A pattern on one end: an omitted field matches anything. */
export type Match = {
  readonly container?: string;
  readonly product?: Product;
};

export type Rule = {
  readonly name: string;
  readonly from: Match;
  readonly to: Match;
  readonly decision: Decision;
  /** Whether a message this rule lets through may wake a cold session. */
  readonly wake?: boolean;
};

export type Limits = {
  readonly maxHops: number;
  readonly rate: { readonly messages: number; readonly windowMs: number };
  readonly maxBodyChars: number;
  readonly messageTtlMs: number;
  readonly approvalTtlMs: number;
  readonly maxAttempts: number;
  /** Refused messages per sender container; past it a refusal is not recorded. */
  readonly refusals: { readonly messages: number; readonly windowMs: number };
};

export type Policy = {
  readonly rules: readonly Rule[];
  readonly limits: Limits;
};

/** An operator's stop or start, kept beside the message audit and as hard to change. */
export type ControlEntry =
  | { readonly at: number; readonly action: "stop" | "start" }
  | { readonly at: number; readonly action: "refusals-limited"; readonly container: string; readonly limit: number; readonly windowMs: number };

export type AuditEntry = {
  readonly at: number;
  readonly message: string;
  readonly thread: string;
  readonly event: Event["kind"] | "receive";
  readonly state: State;
  readonly from: Address;
  readonly to: Address;
  readonly detail: Reason | null;
};
