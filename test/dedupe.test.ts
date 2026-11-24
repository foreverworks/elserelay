import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dedupeFsOver, emptyDedupe, loadDedupe, lookup, nodeDedupeIo, parse, remember, saveDedupe, serialize, writeDurably } from "../src/adapter/dedupe.js";
import type { DedupeFs, OpenFile } from "../src/adapter/dedupe.js";

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

  it("flushes the file, renames it, and flushes the directory, in that order, before the write is done", async () => {
    const calls: string[] = [];
    const fs: DedupeFs = {
      mkdir: async (d) => void calls.push(`mkdir ${d}`),
      writeSynced: async (p, t) => void calls.push(`write+fsync ${p} ${t}`),
      rename: async (a, b) => void calls.push(`rename ${a} ${b}`),
      syncDir: async (d) => void calls.push(`fsync dir ${d}`),
    };
    await writeDurably(fs, "/state/delivered.json", "text");
    expect(calls).toEqual([
      "mkdir /state",
      "write+fsync /state/delivered.json.tmp text",
      "rename /state/delivered.json.tmp /state/delivered.json",
      "fsync dir /state",
    ]);
  });

  it("flushes a file after writing it and before closing it, and the directory the same way", async () => {
    const calls: string[] = [];
    const file = (name: string): OpenFile => ({
      writeFile: async (t) => void calls.push(`${name} write ${t}`),
      sync: async () => void calls.push(`${name} fsync`),
      close: async () => void calls.push(`${name} close`),
    });
    const fs = dedupeFsOver({
      mkdir: async () => undefined,
      open: async (path, flags) => (calls.push(`open ${path} ${flags}`), file(path)),
      rename: async () => undefined,
    });
    await fs.writeSynced("/s/f.tmp", "text");
    await fs.syncDir("/s");
    expect(calls).toEqual([
      "open /s/f.tmp w",
      "/s/f.tmp write text",
      "/s/f.tmp fsync",
      "/s/f.tmp close",
      "open /s r",
      "/s fsync",
      "/s close",
    ]);
  });

  it("closes a file whose flush failed", async () => {
    const calls: string[] = [];
    const fs = dedupeFsOver({
      mkdir: async () => undefined,
      open: async () => ({
        writeFile: async () => undefined,
        sync: async () => {
          throw new Error("EIO");
        },
        close: async () => void calls.push("close"),
      }),
      rename: async () => undefined,
    });
    await expect(fs.writeSynced("/s/f", "x")).rejects.toThrow("EIO");
    expect(calls).toEqual(["close"]);
  });

  it("is not done while the directory is not flushed: a failure there fails the write", async () => {
    const fs: DedupeFs = {
      mkdir: async () => undefined,
      writeSynced: async () => undefined,
      rename: async () => undefined,
      syncDir: async () => {
        throw new Error("EIO");
      },
    };
    await expect(writeDurably(fs, "/state/d.json", "x")).rejects.toThrow("EIO");
  });

  it("does not rename a file that could not be flushed", async () => {
    const calls: string[] = [];
    const fs: DedupeFs = {
      mkdir: async () => undefined,
      writeSynced: async () => {
        throw new Error("ENOSPC");
      },
      rename: async () => void calls.push("rename"),
      syncDir: async () => void calls.push("syncDir"),
    };
    await expect(writeDurably(fs, "/state/d.json", "x")).rejects.toThrow("ENOSPC");
    expect(calls).toEqual([]);
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
