import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyDedupe, loadDedupe, lookup, nodeDedupeIo, parse, remember, saveDedupe, serialize } from "../src/adapter/dedupe.js";

const ok = { ok: true, certainty: "accepted" } as const;

describe("dedupe", () => {
  it("remembers an id with its result", () => {
    const s = remember(emptyDedupe, "a", ok);
    expect(lookup(s, "a")).toEqual(ok);
    expect(lookup(s, "b")).toBeNull();
  });

  it("forgets the oldest past the limit", () => {
    let s = emptyDedupe;
    for (const id of ["a", "b", "c", "d"]) s = remember(s, id, ok, 3);
    expect(lookup(s, "a")).toBeNull();
    expect(s.entries.map((e) => e.id)).toEqual(["b", "c", "d"]);
  });

  it("does not hold an id twice", () => {
    let s = remember(emptyDedupe, "a", ok);
    s = remember(s, "a", { ok: true, certainty: "confirmed" });
    expect(s.entries).toHaveLength(1);
    expect(lookup(s, "a")).toEqual({ ok: true, certainty: "confirmed" });
  });

  it("round-trips through text and keeps the newest on a smaller limit", () => {
    let s = emptyDedupe;
    for (const id of ["a", "b", "c"]) s = remember(s, id, ok);
    expect(parse(serialize(s))).toEqual(s);
    expect(parse(serialize(s), 2).entries.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("reads damaged or foreign text as empty", () => {
    expect(parse("not json")).toEqual(emptyDedupe);
    expect(parse(JSON.stringify({ version: 2, entries: [] }))).toEqual(emptyDedupe);
    expect(parse(JSON.stringify({ version: 1, entries: [{ id: 1 }] }))).toEqual(emptyDedupe);
  });

  it("saves to a file and loads it back, and a missing file is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agw-dedupe-"));
    const path = join(dir, "state", "delivered.json");
    expect(await loadDedupe(nodeDedupeIo, path)).toEqual(emptyDedupe);
    const s = remember(emptyDedupe, "a", ok);
    await saveDedupe(nodeDedupeIo, path, s);
    expect(await loadDedupe(nodeDedupeIo, path)).toEqual(s);
    await writeFile(path, "garbage");
    expect(await loadDedupe(nodeDedupeIo, path)).toEqual(emptyDedupe);
    expect(await readFile(path, "utf8")).toBe("garbage");
  });
});
