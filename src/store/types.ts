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
  /** Replaces everything the container's product had reported. */
  readonly reportPeers: (container: string, product: Peer["product"], peers: readonly Peer[]) => void;
  readonly peers: () => readonly Peer[];
  readonly stopped: () => boolean;
  /** Records the switch in the control log, whether or not it changed anything. */
  readonly setStopped: (stopped: boolean, at: number) => void;
  readonly audit: (since: number) => readonly AuditEntry[];
  /** Every stop and start since `since`, oldest first. */
  readonly controlAudit: (since: number) => readonly ControlEntry[];
  readonly close: () => void;
};
