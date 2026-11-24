/** A driver over explicit in-memory state, for tests of everything that uses a driver. */
import type { Capabilities, Delivered, Driver, Seen } from "./driver.js";

export type FakeState = {
  readonly sessions: readonly Seen[];
  /** What `deliver` was given, in order. */
  readonly delivered: readonly { readonly session: string; readonly text: string }[];
  /** A session listed here refuses with the given answer instead of taking the message. */
  readonly refusals: Readonly<Record<string, Extract<Delivered, { readonly ok: false }>>>;
};

export const emptyFake: FakeState = { sessions: [], delivered: [], refusals: {} };

export const fakeCapabilities: Capabilities = { push: true, wakesIdle: true, joinsTurn: true, certainty: "confirmed" };

export type Fake = {
  readonly driver: Driver;
  readonly read: () => FakeState;
  readonly update: (change: (state: FakeState) => FakeState) => void;
};

/** `beforeDeliver` lets a test hold a delivery open to see what runs beside it. */
export function makeFake(initial: FakeState = emptyFake, beforeDeliver?: (session: string, text: string) => Promise<void>): Fake {
  let state = initial;
  const driver: Driver = {
    product: "fake",
    capabilities: () => fakeCapabilities,
    list: async () => state.sessions,
    status: async (session) => state.sessions.find((s) => s.session === session) ?? null,
    deliver: async (session, text) => {
      await beforeDeliver?.(session, text);
      if (!state.sessions.some((s) => s.session === session)) return { ok: false, retry: false, detail: "no such session" };
      const refusal = state.refusals[session];
      if (refusal) return refusal;
      state = { ...state, delivered: [...state.delivered, { session, text }] };
      return { ok: true, certainty: "confirmed" };
    },
  };
  return { driver, read: () => state, update: (change) => (state = change(state)) };
}
