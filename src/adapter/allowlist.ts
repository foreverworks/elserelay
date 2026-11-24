import type { Driver } from "../drivers/driver.js";

/**
 * Limits a driver to the sessions the operator named. A session outside the list is not reported, and a delivery to one is refused for
 * good, whatever the broker asks: the list is the adapter's own, so it holds even for a broker that is wrong or hostile.
 * It covers the adapter only. A session pulls through the broker's `inbox` with its own claim of who it is, and the adapter is not on that path.
 */
export function restrictSessions(driver: Driver, allowed: readonly string[]): Driver {
  const permitted = new Set(allowed);
  return {
    ...driver,
    list: async () => (await driver.list()).filter((s) => permitted.has(s.session)),
    status: async (session) => (permitted.has(session) ? driver.status(session) : null),
    deliver: async (session, text) =>
      permitted.has(session) ? driver.deliver(session, text) : { ok: false, retry: false, detail: "this adapter does not serve that session" },
  };
}
