import { describe, expect, it } from "vitest";
import { emptyFake, makeFake } from "../src/drivers/fake.js";

const s1 = { session: "s1", title: "one", activity: "idle" } as const;

describe("fake driver", () => {
  it("lists, reports status and records deliveries", async () => {
    const f = makeFake({ ...emptyFake, sessions: [s1] });
    expect(await f.driver.list()).toEqual([s1]);
    expect(await f.driver.status("s1")).toEqual(s1);
    expect(await f.driver.status("nope")).toBeNull();
    expect(await f.driver.deliver("s1", "hi")).toEqual({ ok: true, certainty: "confirmed" });
    expect(f.read().delivered).toEqual([{ session: "s1", text: "hi" }]);
  });

  it("refuses a missing session without a retry and applies a scripted refusal", async () => {
    const f = makeFake({ ...emptyFake, sessions: [s1], refusals: { s1: { ok: false, retry: true, detail: "busy" } } });
    expect(await f.driver.deliver("zz", "x")).toEqual({ ok: false, retry: false, detail: "no such session" });
    expect(await f.driver.deliver("s1", "x")).toEqual({ ok: false, retry: true, detail: "busy" });
    expect(f.read().delivered).toEqual([]);
  });

  it("can change its sessions", async () => {
    const f = makeFake();
    f.update((s) => ({ ...s, sessions: [s1] }));
    expect(await f.driver.list()).toEqual([s1]);
  });
});
