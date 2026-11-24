import { describe, expect, it } from "vitest";
import { restrictSessions } from "../src/adapter/allowlist.js";
import { emptyFake, makeFake } from "../src/drivers/fake.js";

const seen = (session: string) => ({ session, title: null, activity: "idle" as const });

describe("restrictSessions", () => {
  const make = () => makeFake({ ...emptyFake, sessions: [seen("s1"), seen("s2"), seen("s3")] });

  it("reports only the sessions on the list", async () => {
    const driver = restrictSessions(make().driver, ["s1", "s3", "gone"]);
    expect((await driver.list()).map((s) => s.session)).toEqual(["s1", "s3"]);
    expect(await driver.status("s1")).toMatchObject({ session: "s1" });
    expect(await driver.status("s2")).toBeNull();
  });

  it("refuses a delivery to a session off the list for good, and never reaches the product", async () => {
    const fake = make();
    const driver = restrictSessions(fake.driver, ["s1"]);
    const refused = await driver.deliver("s2", "text");
    expect(refused).toMatchObject({ ok: false, retry: false });
    expect(fake.read().delivered).toEqual([]);
    expect(await driver.deliver("s1", "text")).toEqual({ ok: true, certainty: "confirmed" });
    expect(fake.read().delivered).toEqual([{ session: "s1", text: "text" }]);
  });

  it("keeps the product and its capabilities", () => {
    const fake = make();
    const driver = restrictSessions(fake.driver, ["s1"]);
    expect(driver.product).toBe("fake");
    expect(driver.capabilities()).toEqual(fake.driver.capabilities());
  });
});
