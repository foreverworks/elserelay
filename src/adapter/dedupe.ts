/**
 * The ids an adapter has already handed to its product, with the result it gave,
 * so a message the broker sends again is answered and not delivered twice, also
 * after a restart. Only a hand-over is remembered: a failed try must be tried again.
 */
import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export const nodeDedupeIo: DedupeIo = {
  read: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  },
  // Written beside the file and renamed, so a crash leaves the old one whole.
  write: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
  },
};

export async function loadDedupe(io: DedupeIo, path: string, limit: number = DEFAULT_LIMIT): Promise<DedupeState> {
  const text = await io.read(path);
  return text === null ? emptyDedupe : parse(text, limit);
}

export async function saveDedupe(io: DedupeIo, path: string, state: DedupeState): Promise<void> {
  await io.write(path, serialize(state));
}
