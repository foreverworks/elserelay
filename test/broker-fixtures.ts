import { parsePolicy } from "../src/core/policy.js";
import type { Policy, Product } from "../src/core/types.js";
import type { Capabilities } from "../src/drivers/driver.js";
import { makeService } from "../src/broker/service.js";
import type { Service } from "../src/broker/service.js";
import { openStore } from "../src/store/sqlite.js";
import type { Store } from "../src/store/types.js";
import type { AdapterReport } from "../src/wire.js";

export const PUSH: Capabilities = { push: true, wakesIdle: true, joinsTurn: false, certainty: "confirmed" };

export function policyOf(json: unknown): Policy {
  const parsed = parsePolicy(json);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  return parsed.policy;
}

export const ALLOW_ALL = { rules: [{ name: "open", from: {}, to: {}, decision: "allow" }] };

export type Clock = { t: number };

export type Rig = {
  readonly store: Store;
  readonly clock: Clock;
  readonly service: Service;
  /** A second service over the same store, for a policy that changed while messages waited. */
  readonly withPolicy: (policy: Policy) => Service;
};

export const PRODUCTS_OF: ReadonlyMap<string, Product> = new Map<string, Product>([
  ["alpha", "claude"],
  ["beta", "codex"],
  ["gamma", "fake"],
]);

export function rig(policy: Policy, deliveryTimeoutMs = 1000): Rig {
  const store = openStore(":memory:");
  const clock: Clock = { t: 10_000 };
  let n = 0;
  const make = (p: Policy): Service =>
    makeService({ store, policy: p, products: PRODUCTS_OF, now: () => clock.t, newId: () => `id${++n}`, deliveryTimeoutMs });
  const service = make(policy);
  // A restarted broker has the peers in its store but learns the capabilities again from the adapters' reports.
  const withPolicy = (p: Policy): Service => {
    const later = make(p);
    for (const [container, product] of PRODUCTS_OF) {
      const capabilities = service.capabilitiesOf(container);
      if (capabilities === undefined) continue;
      const sessions = store.peers().filter((peer) => peer.container === container).map((peer) => ({ session: peer.session, title: peer.title, activity: peer.activity }));
      later.report(container, report(product, sessions, capabilities));
    }
    return later;
  };
  return { store, clock, service, withPolicy };
}

export const report = (product: Product, sessions: AdapterReport["sessions"], capabilities: Capabilities = PUSH): AdapterReport => ({
  product,
  capabilities,
  sessions,
});

export const seen = (session: string, activity: "idle" | "busy" | "cold" | "unknown" = "idle", title: string | null = null) => ({ session, title, activity });
