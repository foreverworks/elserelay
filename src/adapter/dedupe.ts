/**
 * The ids an adapter has already handed to its product, with the result it gave,
 * so a message the broker sends again is answered and not delivered twice, also
 * after a restart. Only a hand-over is remembered: a failed try must be tried again.
 */
import { dirname } from "node:path";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { z } from "zod";
import type { Delivered } from "../drivers/driver.js";

export type Handed = Extract<Delivered, { readonly ok: true }>;

export type DedupeState = {
  /** Oldest first. */
  readonly entries: readonly { readonly id: string; readonly result: Handed }[];
};

export const DEFAULT_LIMIT = 1000;

export const emptyDedupe: DedupeState = { entries: [] };

export function lookup(state: DedupeState, id: string): Handed | null {
  return state.entries.find((e) => e.id === id)?.result ?? null;
}

export function remember(state: DedupeState, id: string, result: Handed, limit: number = DEFAULT_LIMIT): DedupeState {
  const kept = state.entries.filter((e) => e.id !== id);
  return { entries: [...kept, { id, result }].slice(-limit) };
}

const file = z.object({
  version: z.literal(1),
  entries: z.array(z.object({ id: z.string(), certainty: z.enum(["confirmed", "accepted"]) })),
});

export function serialize(state: DedupeState): string {
  return JSON.stringify({
    version: 1,
    entries: state.entries.map((e) => ({ id: e.id, certainty: e.result.certainty })),
  });
}

/** Anything that does not parse is an empty memory: the broker's own limits bound a repeat. */
export function parse(text: string, limit: number = DEFAULT_LIMIT): DedupeState {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return emptyDedupe;
  }
  const parsed = file.safeParse(json);
  if (!parsed.success) return emptyDedupe;
  const entries = parsed.data.entries.map((e) => ({ id: e.id, result: { ok: true, certainty: e.certainty } as const }));
  return { entries: entries.slice(-limit) };
}

export type DedupeIo = {
  /** Null when the file is not there. */
  readonly read: (path: string) => Promise<string | null>;
  readonly write: (path: string, text: string) => Promise<void>;
};

/** The file operations a durable write is made of, so a test can see the order they run in. */
export type DedupeFs = {
  readonly mkdir: (dir: string) => Promise<void>;
  /** Creates the file, writes it and flushes it to disk before it resolves. */
  readonly writeSynced: (path: string, text: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  /** Flushes the directory entry, so a rename survives a power cut. */
  readonly syncDir: (dir: string) => Promise<void>;
};

/** The few calls of `node:fs/promises` the durable write is built on. */
export type FsOps = {
  readonly mkdir: (dir: string) => Promise<void>;
  readonly open: (path: string, flags: "w" | "r", mode?: number) => Promise<OpenFile>;
  readonly rename: (from: string, to: string) => Promise<void>;
};
export type OpenFile = {
  readonly writeFile: (text: string) => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
};

export const nodeFsOps: FsOps = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  open: (path, flags, mode) => open(path, flags, mode),
  rename,
};

export function dedupeFsOver(ops: FsOps): DedupeFs {
  const flushed = async (path: string, flags: "w" | "r", write: ((file: OpenFile) => Promise<void>) | null): Promise<void> => {
    const file = await ops.open(path, flags, flags === "w" ? 0o600 : undefined);
    try {
      if (write !== null) await write(file);
      await file.sync();
    } finally {
      await file.close();
    }
  };
  return {
    mkdir: ops.mkdir,
    writeSynced: (path, text) => flushed(path, "w", (file) => file.writeFile(text)),
    rename: ops.rename,
    syncDir: (dir) => flushed(dir, "r", null),
  };
}

export const nodeDedupeFs: DedupeFs = dedupeFsOver(nodeFsOps);

/**
 * Written beside the file and renamed, so a crash leaves the old one whole. The write only counts as done once the file and then
 * the directory are on disk: the adapter answers the broker after it, and an id that was lost with a power cut would be handed over twice.
 */
export async function writeDurably(fs: DedupeFs, path: string, text: string): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir);
  const tmp = `${path}.tmp`;
  await fs.writeSynced(tmp, text);
  await fs.rename(tmp, path);
  await fs.syncDir(dir);
}

export const nodeDedupeIo: DedupeIo = {
  read: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
  write: (path, text) => writeDurably(nodeDedupeFs, path, text),
};

export async function loadDedupe(io: DedupeIo, path: string, limit: number = DEFAULT_LIMIT): Promise<DedupeState> {
  const text = await io.read(path);
  return text === null ? emptyDedupe : parse(text, limit);
}

export async function saveDedupe(io: DedupeIo, path: string, state: DedupeState): Promise<void> {
  await io.write(path, serialize(state));
}
