/**
 * What the broker keeps. Every change to a message goes through `apply`, which
 * writes the new state and its audit entry in one transaction.
 */
import type { Address, AuditEntry, ControlEntry, Event, Message, Peer, Tracked } from "../core/types.js";

export type Store = {
  /** A new message, in state `received`, with its audit entry. */
  readonly receive: (message: Message, at: number) => Tracked;
  /** Null when there is no such message; throws when the event is not legal in its state. */
  readonly apply: (id: string, event: Event, at: number) => Tracked | null;
  /**
   * Like `apply`, but only when the message is still as `read` showed it (state, attempts and time of the last change);
   * null otherwise, and nothing is written. For writes the clock decides on, which must not undo an answer given meanwhile.
   */
  readonly applyIf: (id: string, event: Event, at: number, read: Tracked) => Tracked | null;
  readonly get: (id: string) => Tracked | null;
  /** How many times the message was handed out through `inbox`, counted from the audit. */
  readonly pullsOf: (id: string) => number;
  /** Whether a person (or the approver) has already said yes to this message. */
  readonly wasApproved: (id: string) => boolean;
  /** Queued messages for a container, oldest first. */
  readonly queued: (container: string) => readonly Tracked[];
  /** Messages out with an adapter since before `before`, whose outcome never came. */
  readonly overdue: (before: number) => readonly Tracked[];
  readonly held: () => readonly Tracked[];
  /** Messages past their expiry that are not final. */
  readonly expired: (at: number) => readonly Tracked[];
  /** Everything addressed to a session that was put in front of it (queued, delivering or delivered), oldest first. */
  readonly inbox: (to: Address) => readonly Tracked[];
  /**
   * What `inbox` can still hand out to a session, oldest first, and nothing else: queued messages (not one whose last push ended with no
   * outcome, which only the push path retries) and pulled ones whose last pull was at or before `pulledBefore`, none that `markRead` has seen.
   * Settled messages are never read, however many there are.
   */
  readonly pullable: (to: Address, pulledBefore: number) => readonly Tracked[];
  readonly markRead: (to: Address, ids: readonly string[], at: number) => void;
  readonly thread: (thread: string) => readonly Tracked[];
  /** Messages from one container to another received since `since`, refused ones left out. */
  readonly sentSince: (from: string, to: string, since: number) => number;
  /** Messages from one container refused since `since`. */
  readonly refusedSince: (from: string, since: number) => number;
  /**
   * The message from a container that was first handed to the addressee (first hand-out or pull, whatever became of it since) most recently,
   * counting only those first handed since `since`; null when there is none. Later pulls, acknowledgements and settling do not move that time.
   */
  readonly lastReceived: (to: Address, from: string, since: number) => Tracked | null;
  /**
   * Writes the line saying that a container's refusals are no longer recorded, unless one was written for it within
   * `windowMs`. Returns whether it wrote one.
   */
  readonly noteRefusalLimit: (container: string, at: number, limit: number, windowMs: number) => boolean;
  /** Replaces everything the container's product had reported. */
  readonly reportPeers: (container: string, product: Peer["product"], peers: readonly Peer[]) => void;
  readonly peers: () => readonly Peer[];
  readonly stopped: () => boolean;
  /** Records the switch in the control log, whether or not it changed anything. */
  readonly setStopped: (stopped: boolean, at: number) => void;
  readonly audit: (since: number) => readonly AuditEntry[];
  /** Every stop and start, and every notice that a container's refusals went unrecorded, since `since`, oldest first. */
  readonly controlAudit: (since: number) => readonly ControlEntry[];
  readonly close: () => void;
};
