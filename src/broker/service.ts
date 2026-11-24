/**
 * The broker's rules, over a store. No network, no timers: the clock and the
 * id source come in, so every path can be tested in memory.
 *
 * `caller` is always a container label that the transport has already matched
 * to a token. A label that is not in `products` gets `forbidden`.
 */
import { limitReason } from "../core/limits.js";
import { decide } from "../core/policy.js";
import { render } from "../core/render.js";
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
};

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
  readonly activity: Peer["activity"];
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

export type Answered = { readonly ok: true } | { readonly ok: false; readonly why: "not-found" | "not-held" };

export type Service = {
  readonly productOf: (container: string) => Product | undefined;
  readonly listPeers: (caller: string) => readonly PeerView[] | Forbidden;
  readonly send: (caller: string, claim: Claim, to: Target, body: string) => Submitted;
  readonly reply: (caller: string, claim: Claim, messageId: string, body: string) => Submitted;
  readonly inbox: (caller: string, session: string) => { readonly kind: "ok"; readonly messages: readonly Pulled[] } | Forbidden;
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
  // What each adapter last said its product can do. Memory only: an adapter reports again whenever it connects.
  const capabilities = new Map<string, Capabilities>();

  const listed = (to: Address): boolean => store.peers().some((p) => p.container === to.container && p.product === to.product && p.session === to.session);

  const sender = (container: string, product: Product, claim: Claim): Sender => ({ container, product, session: claim.session, title: claim.title });

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
    const message: Message = {
      id,
      thread: link.thread ?? id,
      hop: link.hop,
      replyTo: link.replyTo,
      from,
      to,
      body,
      createdAt: at,
      expiresAt: at + limits.messageTtlMs,
    };
    // Counted before this message is stored, so it does not count itself.
    const sentInWindow = store.sentSince(from.container, target.container, at - limits.rate.windowMs);
    store.receive(message, at);
    const refuse = (reason: Reason): Submitted => {
      store.apply(id, { kind: "refuse", reason }, at);
      return { kind: "refused", id, thread: message.thread, reason };
    };

    if (targetProduct === undefined) return refuse({ kind: "unknown-peer" });
    const decision = decide(policy, from, to);
    // Policy goes before the peer check, so a sender cannot learn which sessions exist in a container it may not reach.
    if (decision.decision === "deny") return refuse({ kind: "policy", rule: decision.rule });
    if (store.stopped()) return refuse({ kind: "stopped" });
    if (!listed(to)) return refuse({ kind: "unknown-peer" });
    const over = limitReason(limits, { hop: link.hop, bodyChars: Array.from(body).length, sentInWindow });
    if (over !== null) return refuse(over);

    if (decision.decision === "ask") {
      store.apply(id, { kind: "hold" }, at);
      return { kind: "accepted", id, thread: message.thread, state: "held", to };
    }
    store.apply(id, { kind: "queue" }, at);
    return { kind: "accepted", id, thread: message.thread, state: "queued", to };
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
    // `ask` is let through: a queued message was approved already, and the state machine cannot hold it a second time.
    return { go: true, wake: decision.wake };
  }

  const hasDelivering = (to: Address): boolean => store.inbox(to, false).some((t) => t.state === "delivering");

  function refuseOrRetry(t: Tracked, detail: string, at: number): void {
    const reason: Reason = { kind: "driver", detail };
    if (t.attempts >= limits.maxAttempts) store.apply(t.message.id, { kind: "refuse", reason }, at);
    else store.apply(t.message.id, { kind: "retry", reason }, at);
  }

  function answer(id: string, event: { readonly kind: "approve" } | { readonly kind: "refuse"; readonly reason: Reason }): Answered {
    const current = store.get(id);
    if (current === null) return { ok: false, why: "not-found" };
    if (current.state !== "held") return { ok: false, why: "not-held" };
    try {
      store.apply(id, event, now());
    } catch {
      // Another process (the command line) answered between the read and the write.
      return { ok: false, why: "not-held" };
    }
    return { ok: true };
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
        return [{ container: p.container, product: p.product, session: p.session, title: p.title, activity: p.activity, needsApproval: decision === "ask" }];
      });
    },

    send: (caller, claim, to, body) => {
      const product = products.get(caller);
      if (product === undefined) return { kind: "forbidden" };
      return submit(sender(caller, product, claim), to, body, { thread: null, hop: 0, replyTo: null });
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
      return submit(sender(caller, product, claim), message.from, body, { thread: message.thread, hop: message.hop + 1, replyTo: message.id });
    },

    inbox: (caller, session) => {
      const product = products.get(caller);
      if (product === undefined) return { kind: "forbidden" };
      // The address is built from the caller's own container, so no argument can name another container's session.
      const to: Address = { container: caller, product, session };
      if (store.stopped()) return { kind: "ok", messages: [] };
      const at = now();
      const pulled: Pulled[] = [];
      for (const t of store.inbox(to, true)) {
        if (t.state !== "queued") continue;
        if (!screen(t, at).go) continue;
        store.apply(t.message.id, { kind: "hand-out", attempt: t.attempts + 1 }, at);
        store.apply(t.message.id, { kind: "deliver", certainty: "confirmed" }, at);
        pulled.push({ id: t.message.id, text: render(t.message) });
      }
      store.markRead(to, pulled.map((p) => p.id), at);
      return { kind: "ok", messages: pulled };
    },

    report: (caller, report) => {
      const product = products.get(caller);
      if (product === undefined) return { kind: "forbidden" };
      if (report.product !== product) return { kind: "wrong-product" };
      const at = now();
      const bySession = new Map(report.sessions.map((s) => [s.session, s]));
      store.reportPeers(
        caller,
        product,
        [...bySession.values()].map((s): Peer => ({ container: caller, product, session: s.session, title: s.title, activity: s.activity, seenAt: at })),
      );
      capabilities.set(caller, report.capabilities);
      return { kind: "ok" };
    },

    nextFor: (container) => {
      const product = products.get(container);
      const caps = capabilities.get(container);
      if (product === undefined || caps === undefined || !caps.push || store.stopped()) return [];
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
        refuseOrRetry(t, result.detail, at);
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
      for (const t of store.expired(at)) store.apply(t.message.id, { kind: "expire" }, at);
      for (const t of store.overdue(at - deps.deliveryTimeoutMs)) {
        refuseOrRetry(t, `no outcome within ${deps.deliveryTimeoutMs} ms`, at);
      }
      for (const t of store.held()) {
        if (t.updatedAt + limits.approvalTtlMs <= at) store.apply(t.message.id, { kind: "refuse", reason: { kind: "approver", answer: "timeout" } }, at);
      }
    },
  };
}
