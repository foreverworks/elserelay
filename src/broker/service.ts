/**
 * The broker's rules, over a store. No network, no timers: the clock and the
 * id source come in, so every path can be tested in memory.
 *
 * `caller` is always a container label that the transport has already matched
 * to a token. A label that is not in `products` gets `forbidden`.
 */
import { bodyFacts } from "../core/body.js";
import { limitReason, refusalsReason } from "../core/limits.js";
import { decide } from "../core/policy.js";
import { oneLine, render } from "../core/render.js";
import type { Address, Certainty, Message, Peer, Policy, Product, Reason, Sender, Tracked } from "../core/types.js";
import type { Capabilities, Delivered } from "../drivers/driver.js";
import type { Store } from "../store/types.js";
import type { AdapterReport, Outcome } from "../wire.js";

export type Deps = {
  readonly store: Store;
  readonly policy: Policy;
  /** Token label to the one product that container runs. */
  readonly products: ReadonlyMap<string, Product>;
  readonly now: () => number;
  readonly newId: () => string;
  /** How long a handed-out message may wait for its outcome before it goes back to the queue. */
  readonly deliveryTimeoutMs: number;
  /** How long a container's adapter may stay disconnected before its sessions are shown as unknown and get nothing pushed. */
  readonly offlineAfterMs?: number;
};

export const OFFLINE_AFTER_MS = 90_000;

/** A `send` continues the hop count of what its session was handed by the target container within this time. */
export const HOP_MEMORY_MS = 600_000;

/** A message nobody acknowledges is returned this many times; the next time it is settled as delivered with certainty `accepted`. */
export const MAX_RETURNS = 3;

/** The most messages one `inbox` call hands out; the rest wait for the next call. */
export const MAX_INBOX_MESSAGES = 50;

const RETURNED_LINE = "This message was given to you before and has not been confirmed as read. Pass its id in `received` on your next inbox call so it is not returned again.";

/** Who the caller says it is. The session is a claim; the container is not. */
export type Claim = { readonly session: string; readonly title: string | null };
export type Target = { readonly container: string; readonly session: string };

export type Forbidden = { readonly kind: "forbidden" };

export type Submitted =
  | { readonly kind: "accepted"; readonly id: string; readonly thread: string; readonly state: "queued" | "held"; readonly to: Address }
  | { readonly kind: "refused"; readonly id: string; readonly thread: string; readonly reason: Reason }
  | { readonly kind: "not-found" }
  | Forbidden;

export type PeerView = {
  readonly container: string;
  readonly product: Product;
  readonly session: string;
  readonly title: string | null;
  /** `unknown` while the container's adapter is offline, whatever it last reported. */
  readonly activity: Peer["activity"];
  /** True when the container's adapter has been disconnected for longer than the broker waits: what is shown may be old and nothing is pushed. */
  readonly offline: boolean;
  /** Whether a person has to approve a message to this peer before it goes. */
  readonly needsApproval: boolean;
};

/** A message to push to an adapter. */
export type HandOut = { readonly id: string; readonly attempt: number; readonly to: Address; readonly text: string };

export type Pulled = { readonly id: string; readonly text: string };

export type ApprovalRequest = {
  readonly id: string;
  readonly thread: string;
  readonly hop: number;
  readonly from: Sender;
  readonly to: Address;
  readonly body: string;
  /** The rule that asked, or null when the default did. */
  readonly rule: string | null;
  readonly heldAt: number;
  /** When no answer becomes a refusal. */
  readonly decideBy: number;
};

export type Answered = { readonly ok: true } | { readonly ok: false; readonly why: "not-found" | "not-held" | "timed-out" };

export type Service = {
  readonly productOf: (container: string) => Product | undefined;
  readonly listPeers: (caller: string) => readonly PeerView[] | Forbidden;
  readonly send: (caller: string, claim: Claim, to: Target, body: string) => Submitted;
  readonly reply: (caller: string, claim: Claim, messageId: string, body: string) => Submitted;
  /** The adapter's stream for this container is open, or has just closed. Only the transport knows. */
  readonly streamOpened: (container: string) => void;
  readonly streamClosed: (container: string) => void;
  /**
   * Marks the messages in `received` as delivered, then hands out what waits. A message is delivered when its addressee
   * says so here or answers it; one it did not confirm comes back after `deliveryTimeoutMs`.
   */
  readonly inbox: (caller: string, session: string, received?: readonly string[]) => { readonly kind: "ok"; readonly messages: readonly Pulled[] } | Forbidden;
  /** Only the first half of `inbox`: nothing is handed out. */
  readonly acknowledge: (caller: string, session: string, received: readonly string[]) => { readonly kind: "ok" } | Forbidden;
  readonly report: (caller: string, report: AdapterReport) => { readonly kind: "ok" } | { readonly kind: "wrong-product" } | Forbidden;
  readonly nextFor: (container: string) => readonly HandOut[];
  readonly outcome: (caller: string, outcome: Outcome) => { readonly applied: boolean };
  readonly approvals: () => readonly ApprovalRequest[];
  readonly approve: (id: string) => Answered;
  readonly refuse: (id: string) => Answered;
  readonly tick: () => void;
  readonly capabilitiesOf: (container: string) => Capabilities | undefined;
};

const keyOf = (a: Address): string => `${a.container}\u0000${a.product}\u0000${a.session}`;

export function makeService(deps: Deps): Service {
  const { store, policy, products, now, newId } = deps;
  const { limits } = policy;
  const offlineAfter = deps.offlineAfterMs ?? OFFLINE_AFTER_MS;
  // When each container's stream last closed, or null while it is open. A container never seen since this broker started counts from its start,
  // so peers left in the store by an earlier run go offline too if the adapter does not come back.
  const startedAt = now();
  const closedAt = new Map<string, number | null>();
  const offline = (container: string): boolean => {
    const since = closedAt.get(container);
    return since !== null && now() - (since ?? startedAt) > offlineAfter;
  };
  // What each adapter last said its product can do. Memory only: an adapter reports again whenever it connects.
  const capabilities = new Map<string, Capabilities>();

  const listed = (to: Address): boolean => store.peers().some((p) => p.container === to.container && p.product === to.product && p.session === to.session);

  const sender = (container: string, product: Product, claim: Claim): Sender => ({
    container,
    product,
    session: oneLine(claim.session),
    title: claim.title === null ? null : oneLine(claim.title) || null,
  });

  /** The hop a `send` starts at: one more than the newest message its session was handed by the target, if any came recently. */
  const hopForSend = (from: Sender, targetContainer: string, at: number): number => {
    const last = store.lastReceived({ container: from.container, product: from.product, session: from.session }, targetContainer, at - HOP_MEMORY_MS);
    return last === null ? 0 : last.message.hop + 1;
  };

  type Verdict =
    | { readonly kind: "go"; readonly state: "queued" | "held" }
    /** `stored` is what the operator reads in the audit; `shown` is what the sender is told. */
    | { readonly kind: "refuse"; readonly stored: Reason; readonly shown: Reason };

  const refusal = (stored: Reason, shown: Reason = stored): Verdict => ({ kind: "refuse", stored, shown });

  function submit(
    from: Sender,
    target: Target,
    body: string,
    link: { readonly thread: string | null; readonly hop: number; readonly replyTo: string | null },
  ): Submitted {
    const at = now();
    const id = newId();
    const targetProduct = products.get(target.container);
    // A container that is not configured has no product; the sender's stands in so the refusal can still be recorded.
    const to: Address = { container: target.container, product: targetProduct ?? from.product, session: target.session };
    const facts = bodyFacts(body);
    const thread = link.thread ?? id;
    // Counted before this message is stored, so it does not count itself.
    const sentInWindow = store.sentSince(from.container, target.container, at - limits.rate.windowMs);

    const decision = targetProduct === undefined ? null : decide(policy, from, to);
    const verdict = ((): Verdict => {
      // An unknown container is answered as a policy refusal that names no rule, so a sender cannot tell it from one it may not reach.
      if (decision === null) return refusal({ kind: "unknown-peer" }, { kind: "policy", rule: null });
      // Policy goes before the peer check, so a sender cannot learn which sessions exist in a container it may not reach.
      if (decision.decision === "deny") return refusal({ kind: "policy", rule: decision.rule });
      if (store.stopped()) return refusal({ kind: "stopped" });
      if (!listed(to)) return refusal({ kind: "unknown-peer" });
      const over = limitReason(limits, { hop: link.hop, bodyChars: facts.chars, sentInWindow });
      // The count of a `send` comes from a message its session was handed, which the sender may not connect with a thread: the reason says so.
      if (over !== null) return refusal(over.kind === "hops" && link.replyTo === null ? { ...over, sendWindowMs: HOP_MEMORY_MS } : over);
      return { kind: "go", state: decision.decision === "ask" ? "held" : "queued" };
    })();

    if (verdict.kind === "refuse") {
      // Past the budget of refusals nothing is stored, so a container that only sends refusable messages cannot grow the file.
      const over = refusalsReason(limits, store.refusedSince(from.container, at - limits.refusals.windowMs));
      if (over !== null) {
        store.noteRefusalLimit(from.container, at, limits.refusals.messages, limits.refusals.windowMs);
        return { kind: "refused", id, thread, reason: over };
      }
    }

    // A refused message is stored without its text: only the length and the hash stay.
    const message: Message = {
      id,
      thread,
      hop: link.hop,
      replyTo: link.replyTo,
      from,
      to,
      body: verdict.kind === "go" ? body : "",
      bodyChars: facts.chars,
      bodySha256: facts.sha256,
      createdAt: at,
      expiresAt: at + limits.messageTtlMs,
    };
    store.receive(message, at);
    if (verdict.kind === "refuse") {
      store.apply(id, { kind: "refuse", reason: verdict.stored }, at);
      return { kind: "refused", id, thread, reason: verdict.shown };
    }
    store.apply(id, { kind: verdict.state === "held" ? "hold" : "queue" }, at);
    return { kind: "accepted", id, thread, state: verdict.state, to };
  }

  type Screened = { readonly go: false } | { readonly go: true; readonly wake: boolean };

  /** The checks that apply again when a message is about to leave: expiry, then the policy as it is now. */
  function screen(t: Tracked, at: number): Screened {
    if (t.message.expiresAt <= at) return { go: false };
    const decision = decide(policy, t.message.from, t.message.to);
    if (decision.decision === "deny") {
      store.apply(t.message.id, { kind: "refuse", reason: { kind: "policy", rule: decision.rule } }, at);
      return { go: false };
    }
    // A rule that let the message in may say `ask` by now. A person who already said yes to this message is not asked again.
    // Only a message that has not left yet can be held again: one already handed out went under an earlier rule.
    if (decision.decision === "ask" && t.state === "queued" && !store.wasApproved(t.message.id)) {
      store.apply(t.message.id, { kind: "hold" }, at);
      return { go: false };
    }
    return { go: true, wake: decision.wake };
  }

  // A message a session pulled does not block the push path: it ends by its own acknowledgement or by expiry.
  const hasDelivering = (to: Address): boolean => store.inbox(to).some((t) => t.state === "delivering" && !t.pulled);

  /** Writes only if the message is still as `t` showed it: the push path and the clock must not undo a newer answer. */
  function refuseOrRetry(t: Tracked, reason: Reason, at: number): void {
    store.applyIf(t.message.id, { kind: t.attempts >= limits.maxAttempts ? "refuse" : "retry", reason }, at, t);
  }

  const timedOut = (t: Tracked, at: number): boolean => t.updatedAt + limits.approvalTtlMs <= at;
  const TIMEOUT: Reason = { kind: "approver", answer: "timeout" };

  function answer(id: string, event: { readonly kind: "approve" } | { readonly kind: "refuse"; readonly reason: Reason }): Answered {
    const current = store.get(id);
    if (current === null) return { ok: false, why: "not-found" };
    if (current.state !== "held") return { ok: false, why: "not-held" };
    const at = now();
    // A yes that arrives at or after the deadline is a timeout: the sender was already allowed to count on a refusal.
    const late = event.kind === "approve" && timedOut(current, at);
    try {
      if (store.applyIf(id, late ? { kind: "refuse", reason: TIMEOUT } : event, at, current) === null) return { ok: false, why: "not-held" };
    } catch {
      // Another process (the command line) answered between the read and the write.
      return { ok: false, why: "not-held" };
    }
    return late ? { ok: false, why: "timed-out" } : { ok: true };
  }

  const isAddressee = (t: Tracked, to: Address): boolean => t.message.to.container === to.container && t.message.to.product === to.product && t.message.to.session === to.session;

  /** The addressee's own word that it has these: they become delivered, with certainty confirmed. */
  function acknowledge(to: Address, ids: readonly string[], at: number): void {
    const done: string[] = [];
    for (const id of ids) {
      const t = store.get(id);
      if (t === null || t.state !== "delivering" || !isAddressee(t, to)) continue;
      if (store.applyIf(id, { kind: "deliver", certainty: "confirmed" }, at, t) !== null) done.push(id);
    }
    store.markRead(to, done, at);
  }

  return {
    productOf: (container) => products.get(container),
    capabilitiesOf: (container) => capabilities.get(container),

    listPeers: (caller) => {
      const product = products.get(caller);
      if (product === undefined) return { kind: "forbidden" };
      const from: Address = { container: caller, product, session: "" };
      return store.peers().flatMap((p): PeerView[] => {
        const decision = decide(policy, from, p).decision;
        if (decision === "deny") return [];
        const away = offline(p.container);
        return [{ container: p.container, product: p.product, session: p.session, title: p.title, activity: away ? "unknown" : p.activity, offline: away, needsApproval: decision === "ask" }];
      });
    },

    send: (caller, claim, to, body) => {
      const product = products.get(caller);
      if (product === undefined) return { kind: "forbidden" };
      const from = sender(caller, product, claim);
      return submit(from, to, body, { thread: null, hop: hopForSend(from, to.container, now()), replyTo: null });
    },

    reply: (caller, claim, messageId, body) => {
      const product = products.get(caller);
      if (product === undefined) return { kind: "forbidden" };
      const original = store.get(messageId);
      // Only what was put in front of this session can be answered: a held or refused message was never shown to it.
      const shown = original !== null && ["queued", "delivering", "delivered"].includes(original.state);
      if (original === null || !shown) return { kind: "not-found" };
      const { message } = original;
      if (message.to.container !== caller || message.to.session !== claim.session) return { kind: "not-found" };
      // An answer proves the message was read, whatever became of its outcome.
      if (original.state === "delivering") acknowledge(message.to, [messageId], now());
      return submit(sender(caller, product, claim), message.from, body, { thread: message.thread, hop: message.hop + 1, replyTo: message.id });
    },

    inbox: (caller, session, received = []) => {
      const product = products.get(caller);
      if (product === undefined) return { kind: "forbidden" };
      // The address is built from the caller's own container, so no argument can name another container's session.
      const to: Address = { container: caller, product, session };
      const at = now();
      acknowledge(to, received, at);
      if (store.stopped()) return { kind: "ok", messages: [] };
      const pulled: Pulled[] = [];
      // The store returns only what can be handed out: queued messages (not one whose push ended with no outcome, which only the push path
      // retries) and pulled ones not confirmed within the delivery timeout.
      for (const t of store.pullable(to, at - deps.deliveryTimeoutMs)) {
        const again = t.state === "delivering";
        if (pulled.length >= MAX_INBOX_MESSAGES) break;
        if (!screen(t, at).go) continue;
        // The first pull is not a return. A message that keeps coming back unconfirmed is settled instead of returned for ever.
        if (again && store.pullsOf(t.message.id) - 1 >= MAX_RETURNS) {
          store.applyIf(t.message.id, { kind: "deliver", certainty: "accepted" }, at, t);
          continue;
        }
        if (store.applyIf(t.message.id, { kind: "pull" }, at, t) === null) continue;
        pulled.push({ id: t.message.id, text: again ? `${RETURNED_LINE}\n\n${render(t.message)}` : render(t.message) });
      }
      return { kind: "ok", messages: pulled };
    },

    acknowledge: (caller, session, received) => {
      const product = products.get(caller);
      if (product === undefined) return { kind: "forbidden" };
      acknowledge({ container: caller, product, session }, received, now());
      return { kind: "ok" };
    },

    streamOpened: (container) => {
      closedAt.set(container, null);
    },
    streamClosed: (container) => {
      closedAt.set(container, now());
    },

    report: (caller, report) => {
      const product = products.get(caller);
      if (product === undefined) return { kind: "forbidden" };
      if (report.product !== product) return { kind: "wrong-product" };
      const at = now();
      // What an adapter reports ends up in list_peers, the approver's view and the audit, so it is cleaned here. A session id that
      // cleaning changes would name a different session than the product knows, so it is left out.
      const clean = report.sessions.filter((s) => oneLine(s.session) === s.session && s.session !== "");
      const bySession = new Map(clean.map((s) => [s.session, s]));
      store.reportPeers(
        caller,
        product,
        [...bySession.values()].map(
          (s): Peer => ({ container: caller, product, session: s.session, title: s.title === null ? null : oneLine(s.title) || null, activity: s.activity, seenAt: at }),
        ),
      );
      capabilities.set(caller, report.capabilities);
      return { kind: "ok" };
    },

    nextFor: (container) => {
      const product = products.get(container);
      const caps = capabilities.get(container);
      if (product === undefined || caps === undefined || !caps.push || store.stopped() || offline(container)) return [];
      const at = now();
      const peers = store.peers().filter((p) => p.container === container && p.product === product);
      const inFlight = new Map<string, boolean>();
      const out: HandOut[] = [];
      for (const t of store.queued(container)) {
        const { to } = t.message;
        if (to.product !== product) continue;
        const screened = screen(t, at);
        if (!screened.go) continue;
        const peer = peers.find((p) => p.session === to.session);
        if (peer === undefined) continue;
        const awake = peer.activity === "idle" || peer.activity === "busy";
        if (!awake && !screened.wake) continue;
        const key = keyOf(to);
        // One message at a time per session keeps their order, and a lost outcome blocks only its own session.
        const busy = inFlight.get(key) ?? hasDelivering(to);
        if (busy) continue;
        const attempt = t.attempts + 1;
        store.apply(t.message.id, { kind: "hand-out", attempt }, at);
        inFlight.set(key, true);
        out.push({ id: t.message.id, attempt, to, text: render(t.message) });
      }
      return out;
    },

    outcome: (caller, outcome) => {
      const t = store.get(outcome.id);
      // Another container's message, an unknown id, an old attempt and a final message are all the same quiet no-op.
      if (t === null || t.message.to.container !== caller || t.state !== "delivering" || t.attempts !== outcome.attempt) {
        return { applied: false };
      }
      const at = now();
      const result: Delivered = outcome.result;
      if (result.ok) {
        const certainty: Certainty = result.certainty;
        store.apply(t.message.id, { kind: "deliver", certainty }, at);
      } else if (result.retry) {
        refuseOrRetry(t, { kind: "driver", detail: result.detail }, at);
      } else {
        store.apply(t.message.id, { kind: "refuse", reason: { kind: "driver", detail: result.detail } }, at);
      }
      return { applied: true };
    },

    approvals: () =>
      store.held().map((t): ApprovalRequest => ({
        id: t.message.id,
        thread: t.message.thread,
        hop: t.message.hop,
        from: t.message.from,
        to: t.message.to,
        body: t.message.body,
        rule: decide(policy, t.message.from, t.message.to).rule,
        heldAt: t.updatedAt,
        decideBy: t.updatedAt + limits.approvalTtlMs,
      })),

    approve: (id) => answer(id, { kind: "approve" }),
    refuse: (id) => answer(id, { kind: "refuse", reason: { kind: "approver", answer: "no" } }),

    tick: () => {
      const at = now();
      for (const t of store.expired(at)) store.applyIf(t.message.id, { kind: "expire" }, at, t);
      for (const t of store.overdue(at - deps.deliveryTimeoutMs)) refuseOrRetry(t, { kind: "no-outcome", ms: deps.deliveryTimeoutMs }, at);
      for (const t of store.held()) {
        if (timedOut(t, at)) store.applyIf(t.message.id, { kind: "refuse", reason: TIMEOUT }, at, t);
      }
    },
  };
}
