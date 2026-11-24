import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravityCapabilities, createAntigravityDriver, defaultSummariesPath, nodeAntigravityEnv } from "../src/drivers/antigravity.js";

// The table as `agy` 1.5.16 creates it, observed without a login (docs/drivers/antigravity.md).
const TABLE = `CREATE TABLE \`conversation_summaries\` (\`conversation_id\` text,\`title\` text NOT NULL DEFAULT "",\`preview\` text NOT NULL DEFAULT "",
  \`step_count\` integer NOT NULL DEFAULT 0,\`last_modified_time\` datetime NOT NULL,\`workspace_uris\` text NOT NULL,\`status\` text NOT NULL DEFAULT "",
  \`not_fully_idle\` numeric NOT NULL DEFAULT false,\`killed\` numeric NOT NULL DEFAULT false,\`last_user_input_time\` datetime NOT NULL,
  PRIMARY KEY (\`conversation_id\`))`;

const NOW = Date.parse("2026-11-24T12:00:00Z");
const MIN = 60_000;

let dir: string;
let path: string;
let logs: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "elserelay-agy-"));
  path = join(dir, "conversation_summaries.db");
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(sql: string = TABLE, rows: readonly (readonly (string | number)[])[] = []): void {
  const db = new DatabaseSync(path);
  db.exec(sql);
  for (const row of rows) {
    db.prepare(
      "INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, not_fully_idle, killed, last_user_input_time) VALUES (?, ?, ?, '[]', ?, ?, 0)",
    ).run(...row);
  }
  db.close();
}

const driver = () => createAntigravityDriver(nodeAntigravityEnv(path, (l) => logs.push(l), () => NOW));

describe("the Antigravity driver", () => {
  it("cannot be pushed to and says so", () => {
    expect(driver().capabilities()).toEqual({ push: false, wakesIdle: false, joinsTurn: false, certainty: "accepted" });
    expect(antigravityCapabilities.push).toBe(false);
    expect(driver().product).toBe("antigravity");
  });

  it("lists conversations newest first with the activity read from the summary", async () => {
    seed(TABLE, [
      ["c-idle", "Fix the build", NOW - 5 * MIN, 0, 0],
      ["c-busy", "", NOW - 1 * MIN, 1, 0],
      ["c-cold", "Old", NOW - 3 * 60 * MIN, 0, 0],
      ["c-gone", "Killed", NOW - 2 * MIN, 0, 1],
    ]);
    expect(await driver().list()).toEqual([
      { session: "c-busy", title: null, activity: "busy" },
      { session: "c-idle", title: "Fix the build", activity: "idle" },
      { session: "c-cold", title: "Old", activity: "cold" },
    ]);
    expect(logs).toEqual([]);
  });

  it("reads a time written as seconds, milliseconds or a date string, and calls an unreadable one unknown", async () => {
    seed(TABLE, [
      ["secs", "a", Math.floor((NOW - MIN) / 1000), 0, 0],
      ["iso", "b", "2026-11-24T11:59:00Z", 0, 0],
      ["junk", "c", "yesterday-ish", 0, 0],
    ]);
    const seen = new Map((await driver().list()).map((s) => [s.session, s.activity]));
    expect(seen.get("secs")).toBe("idle");
    expect(seen.get("iso")).toBe("idle");
    expect(seen.get("junk")).toBe("unknown");
  });

  it("answers status from the same list", async () => {
    seed(TABLE, [["c1", "One", NOW, 0, 0]]);
    const d = driver();
    expect(await d.status("c1")).toEqual({ session: "c1", title: "One", activity: "idle" });
    expect(await d.status("nope")).toBeNull();
  });

  it("lists nothing and logs once when the table is missing, however often it is asked", async () => {
    seed("CREATE TABLE other (x text)");
    const d = driver();
    expect(await d.list()).toEqual([]);
    expect(await d.list()).toEqual([]);
    expect(await d.list()).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("conversation_summaries");
  });

  it("lists nothing and logs once when a column is missing", async () => {
    seed("CREATE TABLE conversation_summaries (conversation_id text, title text)");
    const d = driver();
    expect(await d.list()).toEqual([]);
    expect(await d.list()).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it("lists nothing and logs once when the file is not there, and recovers when it appears", async () => {
    const d = driver();
    expect(await d.list()).toEqual([]);
    expect(await d.list()).toEqual([]);
    expect(logs).toHaveLength(1);
    // A read-write open would have created an empty database here.
    expect(existsSync(path)).toBe(false);
    seed(TABLE, [["c1", "One", NOW, 0, 0]]);
    expect(await d.list()).toHaveLength(1);
    rmSync(path);
    expect(await d.list()).toEqual([]);
    expect(logs).toHaveLength(2);
  });

  it("skips a row it cannot read and keeps the others", async () => {
    seed(TABLE, [["ok", "Fine", NOW, 0, 0]]);
    const d = createAntigravityDriver({ rows: () => [{ conversation_id: "ok", title: "Fine", last_modified_time: NOW }, { conversation_id: 7 }, null, "x"], now: () => NOW, log: (l) => logs.push(l) });
    expect(await d.list()).toEqual([{ session: "ok", title: "Fine", activity: "idle" }]);
  });

  it("refuses a delivery without a retry, because the broker never pushes to it", async () => {
    expect(await driver().deliver("c1", "text")).toMatchObject({ ok: false, retry: false });
  });

  it("finds the database under ~/.gemini by default", () => {
    expect(defaultSummariesPath("/home/x")).toBe("/home/x/.gemini/antigravity-cli/conversation_summaries.db");
  });
});
