import { describe, expect, it } from "vitest";
import { driverFor, readConfig, servingLine } from "../src/adapter/main.js";
import type { Config } from "../src/adapter/main.js";

const BASE = { GATEWAY_URL: "http://broker.example:8081", GATEWAY_TOKEN_FILE: "/run/token", GATEWAY_STATE_DIR: "/var/state" };

const ok = (source: Record<string, string>, home = "/home/u"): Config => {
  const config = readConfig(source, home);
  if (typeof config === "string") throw new Error(config);
  return config;
};

describe("readConfig", () => {
  it("takes each of the four products", () => {
    for (const product of ["claude", "codex", "antigravity", "fake"]) expect(ok({ ...BASE, GATEWAY_PRODUCT: product }).product).toBe(product);
  });

  it("names every problem and rejects a product it does not know", () => {
    expect(readConfig({ ...BASE, GATEWAY_PRODUCT: "gemini" })).toContain("GATEWAY_PRODUCT");
    expect(readConfig({})).toMatch(/GATEWAY_URL.*GATEWAY_TOKEN_FILE.*GATEWAY_PRODUCT.*GATEWAY_STATE_DIR/);
    expect(readConfig({ ...BASE, GATEWAY_URL: "not a url", GATEWAY_PRODUCT: "fake" })).toContain("GATEWAY_URL");
  });

  it("reads GATEWAY_SESSIONS as a list of session ids split on commas and spaces, and treats an unset variable as every session", () => {
    const base = { ...BASE, GATEWAY_PRODUCT: "fake" };
    expect(ok(base).sessions).toBeNull();
    expect(ok({ ...base, GATEWAY_SESSIONS: "a1 b2" }).sessions).toEqual(["a1", "b2"]);
    expect(ok({ ...base, GATEWAY_SESSIONS: "a1,b2 c3\td4" }).sessions).toEqual(["a1", "b2", "c3", "d4"]);
    expect(ok({ ...base, GATEWAY_SESSIONS: "a1" }).sessions).toEqual(["a1"]);
    expect(ok({ ...base, GATEWAY_SESSIONS: " a1, b2 ,,c3 " }).sessions).toEqual(["a1", "b2", "c3"]);
    expect(readConfig({ ...base, GATEWAY_SESSIONS: " , " })).toContain("GATEWAY_SESSIONS");
    // Present but empty is a mistake, not "every session": the value may have been lost on the way.
    expect(readConfig({ ...base, GATEWAY_SESSIONS: "" })).toContain("GATEWAY_SESSIONS");
    expect(readConfig({ ...base, GATEWAY_SESSIONS: "   " })).toContain("GATEWAY_SESSIONS");
    // The other settings still treat an empty value as unset.
    expect(ok({ ...base, CODEX_HOME: "" }).codexSocket).toBe("/home/u/.codex/app-server-control/app-server-control.sock");
  });

  it("says at start which sessions it serves", () => {
    const base = { ...BASE, GATEWAY_PRODUCT: "fake" };
    expect(servingLine(ok(base))).toBe("serving every fake session");
    expect(servingLine(ok({ ...base, GATEWAY_SESSIONS: "a1 b2" }))).toBe("serving only these sessions: a1, b2");
  });

  it("finds the Codex socket under CODEX_HOME, else under ~/.codex, and CODEX_SOCKET wins", () => {
    const codex = { ...BASE, GATEWAY_PRODUCT: "codex" };
    expect(ok(codex).codexSocket).toBe("/home/u/.codex/app-server-control/app-server-control.sock");
    expect(ok({ ...codex, CODEX_HOME: "/data/codex" }).codexSocket).toBe("/data/codex/app-server-control/app-server-control.sock");
    expect(ok({ ...codex, CODEX_HOME: "/data/codex", CODEX_SOCKET: "/run/c.sock" }).codexSocket).toBe("/run/c.sock");
    expect(ok({ ...codex, CODEX_SOCKET: "" }).codexSocket).toBe("/home/u/.codex/app-server-control/app-server-control.sock");
  });

  it("finds the Antigravity summaries under ~/.gemini unless told", () => {
    const agy = { ...BASE, GATEWAY_PRODUCT: "antigravity" };
    expect(ok(agy).antigravityDb).toBe("/home/u/.gemini/antigravity-cli/conversation_summaries.db");
    expect(ok({ ...agy, ANTIGRAVITY_SUMMARIES_DB: "/x/s.db" }).antigravityDb).toBe("/x/s.db");
  });
});

describe("driverFor", () => {
  it("builds the driver of each product", () => {
    const logs: string[] = [];
    for (const product of ["claude", "codex", "antigravity", "fake"] as const) {
      const driver = driverFor(ok({ ...BASE, GATEWAY_PRODUCT: product }), (l) => logs.push(l));
      expect(driver.product).toBe(product);
    }
    expect(driverFor(ok({ ...BASE, GATEWAY_PRODUCT: "antigravity" }), () => undefined).capabilities().push).toBe(false);
    expect(driverFor(ok({ ...BASE, GATEWAY_PRODUCT: "codex" }), () => undefined).capabilities()).toMatchObject({ push: true, wakesIdle: true });
  });

  it("limits the driver to GATEWAY_SESSIONS when it is set, and leaves it whole when it is not", async () => {
    const config = ok({ ...BASE, GATEWAY_PRODUCT: "fake", GATEWAY_SESSIONS: "only" });
    const driver = driverFor(config, () => undefined);
    // The fake driver has no sessions, so nothing is listed either way; the wrapper shows in how it answers a delivery.
    expect(await driver.deliver("other", "x")).toMatchObject({ ok: false, retry: false, detail: expect.stringContaining("does not serve") });
    expect(await driverFor(ok({ ...BASE, GATEWAY_PRODUCT: "fake" }), () => undefined).deliver("other", "x")).toMatchObject({ detail: "no such session" });
  });

  it("makes a Codex driver whose list throws, rather than an empty list, when the socket is not there", async () => {
    const driver = driverFor(ok({ ...BASE, GATEWAY_PRODUCT: "codex", CODEX_SOCKET: "/nonexistent/agw.sock" }), () => undefined);
    await expect(driver.list()).rejects.toThrow();
  });

  it("makes an Antigravity driver that logs once and lists none when the database is missing", async () => {
    const logs: string[] = [];
    const driver = driverFor(ok({ ...BASE, GATEWAY_PRODUCT: "antigravity", ANTIGRAVITY_SUMMARIES_DB: "/nonexistent/s.db" }), (l) => logs.push(l));
    expect(await driver.list()).toEqual([]);
    expect(await driver.list()).toEqual([]);
    expect(logs).toHaveLength(1);
  });
});
