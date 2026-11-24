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
  /** Whether a person (or the approver) has already said yes to this message. */
  readonly wasApproved: (id: string) => boolean;
  /** Queued messages for a container, oldest first. */
  readonly queued: (container: string) => readonly Tracked[];
  /** Messages out with an adapter since before `before`, whose outcome never came. */
  readonly overdue: (before: number) => readonly Tracked[];
  readonly held: () => readonly Tracked[];
  /** Messages past their expiry that are not final. */
  readonly expired: (at: number) => readonly Tracked[];
  /** What is addressed to a session, newest last; `unreadOnly` leaves out what `markRead` has seen. */
  readonly inbox: (to: Address, unreadOnly: boolean) => readonly Tracked[];
  readonly markRead: (to: Address, ids: readonly string[], at: number) => void;
  readonly thread: (thread: string) => readonly Tracked[];
  /** Messages from one container to another received since `since`, refused ones left out. */
  readonly sentSince: (from: string, to: string, since: number) => number;
  /** Messages from one container refused since `since`. */
  readonly refusedSince: (from: string, since: number) => number;
  /** The newest message the addressee was handed (delivering or delivered) from a container since `since`, or null. */
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
