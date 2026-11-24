import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import { z } from "zod";
import { step } from "../core/states.js";
import { PRODUCTS, STATES } from "../core/types.js";
import type { AuditEntry, ControlEntry, Event, Message, Peer, Reason, Tracked } from "../core/types.js";
import type { Store } from "./types.js";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread TEXT NOT NULL,
  hop INTEGER NOT NULL,
  reply_to TEXT,
  from_container TEXT NOT NULL,
  from_product TEXT NOT NULL,
  from_session TEXT NOT NULL,
  from_title TEXT,
  to_container TEXT NOT NULL,
  to_product TEXT NOT NULL,
  to_session TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${STATES.map((s) => `'${s}'`).join(", ")})),
  attempts INTEGER NOT NULL,
  reason TEXT,
  certainty TEXT CHECK (certainty IN ('confirmed', 'accepted')),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX messages_by_state ON messages (state, to_container, received_at);
CREATE INDEX messages_by_thread ON messages (thread, created_at);
CREATE INDEX messages_by_pair ON messages (from_container, to_container, received_at);
CREATE INDEX messages_by_addressee ON messages (to_container, to_product, to_session, created_at);

CREATE TABLE reads (
  message_id TEXT PRIMARY KEY REFERENCES messages (id),
  read_at INTEGER NOT NULL
) STRICT;

CREATE TABLE peers (
  container TEXT NOT NULL,
  product TEXT NOT NULL,
  session TEXT NOT NULL,
  title TEXT,
  activity TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (container, product, session)
) STRICT;

CREATE TABLE control (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  at INTEGER NOT NULL
) STRICT;

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  message TEXT NOT NULL,
  thread TEXT NOT NULL,
  event TEXT NOT NULL,
  state TEXT NOT NULL,
  from_container TEXT NOT NULL,
  from_product TEXT NOT NULL,
  from_session TEXT NOT NULL,
  to_container TEXT NOT NULL,
  to_product TEXT NOT NULL,
  to_session TEXT NOT NULL,
  detail TEXT
) STRICT;
CREATE INDEX audit_by_time ON audit (at);
CREATE TRIGGER audit_never_updated BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit entries are never changed'); END;
CREATE TRIGGER audit_never_deleted BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit entries are never removed'); END;
`;

// Added in version 2, so a version 1 file gets it by `migrate` without losing a message.
const CONTROL_LOG = `
CREATE TABLE control_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('stop', 'start'))
) STRICT;
CREATE INDEX control_log_by_time ON control_log (at);
CREATE TRIGGER control_log_never_updated BEFORE UPDATE ON control_log
BEGIN SELECT RAISE(ABORT, 'control log entries are never changed'); END;
CREATE TRIGGER control_log_never_deleted BEFORE DELETE ON control_log
BEGIN SELECT RAISE(ABORT, 'control log entries are never removed'); END;
`;

const reasonSchema: z.ZodType<Reason> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("policy"), rule: z.string().nullable() }),
  z.strictObject({ kind: z.literal("approver"), answer: z.enum(["no", "timeout"]) }),
  z.strictObject({ kind: z.literal("hops"), limit: z.number() }),
  z.strictObject({ kind: z.literal("rate"), limit: z.number(), windowMs: z.number() }),
  z.strictObject({ kind: z.literal("stopped") }),
  z.strictObject({ kind: z.literal("cold") }),
  z.strictObject({ kind: z.literal("unknown-peer") }),
  z.strictObject({ kind: z.literal("too-long"), limit: z.number() }),
  z.strictObject({ kind: z.literal("driver"), detail: z.string() }),
]);

const json = z.string().nullable().transform((text) => (text === null ? null : reasonSchema.parse(JSON.parse(text))));

const messageRow = z.object({
  id: z.string(),
  thread: z.string(),
  hop: z.number(),
  reply_to: z.string().nullable(),
  from_container: z.string(),
  from_product: z.enum(PRODUCTS),
  from_session: z.string(),
  from_title: z.string().nullable(),
  to_container: z.string(),
  to_product: z.enum(PRODUCTS),
  to_session: z.string(),
  body: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  state: z.enum(STATES),
  attempts: z.number(),
  reason: json,
  certainty: z.enum(["confirmed", "accepted"]).nullable(),
  updated_at: z.number(),
});

const peerRow = z.object({
  container: z.string(),
  product: z.enum(PRODUCTS),
  session: z.string(),
  title: z.string().nullable(),
  activity: z.enum(["idle", "busy", "cold", "unknown"]),
  seen_at: z.number(),
});

const auditRow = z.object({
  at: z.number(),
  message: z.string(),
  thread: z.string(),
  event: z.enum(["receive", "refuse", "hold", "approve", "queue", "hand-out", "deliver", "retry", "expire"]),
  state: z.enum(STATES),
  from_container: z.string(),
  from_product: z.enum(PRODUCTS),
  from_session: z.string(),
  to_container: z.string(),
  to_product: z.enum(PRODUCTS),
  to_session: z.string(),
  detail: json,
});

const controlRow = z.object({ at: z.number(), action: z.enum(["stop", "start"]) });

function toTracked(raw: unknown): Tracked {
  const row = messageRow.parse(raw);
  const message: Message = {
    id: row.id,
    thread: row.thread,
    hop: row.hop,
    replyTo: row.reply_to,
    from: { container: row.from_container, product: row.from_product, session: row.from_session, title: row.from_title },
    to: { container: row.to_container, product: row.to_product, session: row.to_session },
    body: row.body,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  return { message, state: row.state, attempts: row.attempts, reason: row.reason, certainty: row.certainty, updatedAt: row.updated_at };
}

function toAudit(raw: unknown): AuditEntry {
  const row = auditRow.parse(raw);
  return {
    at: row.at,
    message: row.message,
    thread: row.thread,
    event: row.event,
    state: row.state,
    from: { container: row.from_container, product: row.from_product, session: row.from_session },
    to: { container: row.to_container, product: row.to_product, session: row.to_session },
    detail: row.detail,
  };
}

function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrate(db: DatabaseSync): void {
  const row = z.object({ user_version: z.number() }).parse(db.prepare("PRAGMA user_version").get());
  if (row.user_version === SCHEMA_VERSION) return;
  if (row.user_version !== 0 && row.user_version !== 1) {
    throw new Error(`the store file has schema version ${row.user_version}; this build reads version ${SCHEMA_VERSION}`);
  }
  inTransaction(db, () => {
    if (row.user_version === 0) db.exec(SCHEMA);
    db.exec(CONTROL_LOG);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

const detailOf = (event: Event): Reason | null => (event.kind === "refuse" || event.kind === "retry" ? event.reason : null);
const encode = (reason: Reason | null): string | null => (reason === null ? null : JSON.stringify(reason));

/** `path` is a file, or `:memory:` for a store that lives as long as the process. */
export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  const prepare = (sql: string): StatementSync => db.prepare(sql);
  const all = (statement: StatementSync, ...params: SQLInputValue[]): readonly unknown[] => statement.all(...params);

  const insertMessage = prepare(`INSERT INTO messages (id, thread, hop, reply_to, from_container, from_product, from_session, from_title,
    to_container, to_product, to_session, body, created_at, expires_at, received_at, state, attempts, reason, certainty, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, NULL, NULL, ?)`);
  const insertAudit = prepare(`INSERT INTO audit (at, message, thread, event, state, from_container, from_product, from_session,
    to_container, to_product, to_session, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const selectOne = prepare("SELECT * FROM messages WHERE id = ?");
  const updateMessage = prepare("UPDATE messages SET state = ?, attempts = ?, reason = ?, certainty = ?, updated_at = ? WHERE id = ?");
  const selectQueued = prepare("SELECT * FROM messages WHERE state = 'queued' AND to_container = ? ORDER BY received_at, rowid");
  const selectOverdue = prepare("SELECT * FROM messages WHERE state = 'delivering' AND updated_at < ? ORDER BY updated_at, rowid");
  const selectHeld = prepare("SELECT * FROM messages WHERE state = 'held' ORDER BY received_at, rowid");
  const selectExpired = prepare(
    "SELECT * FROM messages WHERE state NOT IN ('delivered', 'refused', 'expired') AND expires_at <= ? ORDER BY expires_at, rowid",
  );
  // Held, refused and expired messages were never put in front of the receiver, so its inbox leaves them out.
  const inboxWhere = `FROM messages m WHERE m.to_container = ? AND m.to_product = ? AND m.to_session = ?
    AND m.state IN ('queued', 'delivering', 'delivered')`;
  const selectInbox = prepare(`SELECT m.* ${inboxWhere} ORDER BY m.created_at, m.rowid`);
  const selectUnread = prepare(
    `SELECT m.* ${inboxWhere} AND NOT EXISTS (SELECT 1 FROM reads r WHERE r.message_id = m.id) ORDER BY m.created_at, m.rowid`,
  );
  const insertRead = prepare(`INSERT OR IGNORE INTO reads (message_id, read_at)
    SELECT id, ? FROM messages WHERE id = ? AND to_container = ? AND to_product = ? AND to_session = ?`);
  const selectThread = prepare("SELECT * FROM messages WHERE thread = ? ORDER BY created_at, rowid");
  const countSent = prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE from_container = ? AND to_container = ? AND received_at >= ? AND state != 'refused'",
  );
  const deletePeers = prepare("DELETE FROM peers WHERE container = ? AND product = ?");
  const insertPeer = prepare("INSERT INTO peers (container, product, session, title, activity, seen_at) VALUES (?, ?, ?, ?, ?, ?)");
  const selectPeers = prepare("SELECT * FROM peers ORDER BY container, product, session");
  const selectStopped = prepare("SELECT value FROM control WHERE name = 'stopped'");
  const upsertStopped = prepare(
    "INSERT INTO control (name, value, at) VALUES ('stopped', ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, at = excluded.at",
  );
  const selectAudit = prepare("SELECT * FROM audit WHERE at >= ? ORDER BY id");
  const selectApproved = prepare("SELECT 1 AS yes FROM audit WHERE message = ? AND event = 'approve' LIMIT 1");
  const insertControl = prepare("INSERT INTO control_log (at, action) VALUES (?, ?)");
  const selectControl = prepare("SELECT at, action FROM control_log WHERE at >= ? ORDER BY id");

  const audit = (tracked: Tracked, event: AuditEntry["event"], at: number, detail: Reason | null): void => {
    const { from, to, id, thread } = tracked.message;
    insertAudit.run(at, id, thread, event, tracked.state, from.container, from.product, from.session, to.container, to.product, to.session, encode(detail));
  };

  const find = (id: string): Tracked | null => {
    const row = selectOne.get(id);
    return row === undefined ? null : toTracked(row);
  };

  return {
    receive: (message, at) =>
      inTransaction(db, () => {
        const { from, to } = message;
        insertMessage.run(
          message.id, message.thread, message.hop, message.replyTo,
          from.container, from.product, from.session, from.title,
          to.container, to.product, to.session,
          message.body, message.createdAt, message.expiresAt, at, at,
        );
        const tracked: Tracked = { message, state: "received", attempts: 0, reason: null, certainty: null, updatedAt: at };
        audit(tracked, "receive", at, null);
        return tracked;
      }),

    apply: (id, event, at) =>
      inTransaction(db, () => {
        const current = find(id);
        if (current === null) return null;
        const moved = step(current, event, at);
        if (!moved.ok) throw new Error(moved.why);
        const { next } = moved;
        updateMessage.run(next.state, next.attempts, encode(next.reason), next.certainty, next.updatedAt, id);
        audit(next, event.kind, at, detailOf(event));
        return next;
      }),

    get: find,
    wasApproved: (id) => selectApproved.get(id) !== undefined,
    queued: (container) => all(selectQueued, container).map(toTracked),
    overdue: (before) => all(selectOverdue, before).map(toTracked),
    held: () => all(selectHeld).map(toTracked),
    expired: (at) => all(selectExpired, at).map(toTracked),
    inbox: (to, unreadOnly) => all(unreadOnly ? selectUnread : selectInbox, to.container, to.product, to.session).map(toTracked),

    markRead: (to, ids, at) =>
      inTransaction(db, () => {
        for (const id of ids) insertRead.run(at, id, to.container, to.product, to.session);
      }),

    thread: (thread) => all(selectThread, thread).map(toTracked),
    sentSince: (from, to, since) => z.object({ n: z.number() }).parse(countSent.get(from, to, since)).n,

    reportPeers: (container, product, peers) =>
      inTransaction(db, () => {
        deletePeers.run(container, product);
        for (const peer of peers) insertPeer.run(container, product, peer.session, peer.title, peer.activity, peer.seenAt);
      }),

    peers: () => all(selectPeers).map((raw): Peer => {
      const row = peerRow.parse(raw);
      return { container: row.container, product: row.product, session: row.session, title: row.title, activity: row.activity, seenAt: row.seen_at };
    }),

    stopped: () => {
      const row = selectStopped.get();
      return row !== undefined && z.object({ value: z.number() }).parse(row).value === 1;
    },
    setStopped: (stopped, at) =>
      inTransaction(db, () => {
        upsertStopped.run(stopped ? 1 : 0, at);
        insertControl.run(at, stopped ? "stop" : "start");
      }),

    audit: (since) => all(selectAudit, since).map(toAudit),
    controlAudit: (since) => all(selectControl, since).map((raw): ControlEntry => controlRow.parse(raw)),
    close: () => db.close(),
  };
}
