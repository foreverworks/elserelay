import { describe, expect, it } from "vitest";
import { driverFor, readConfig } from "../src/adapter/main.js";
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
