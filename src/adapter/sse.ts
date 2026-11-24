/**
 * A server-sent event stream, read as bytes: every `data:` payload that is a
 * `ToAdapter` comes out, everything else (comments, other fields, unknown kinds,
 * text that is not JSON) is dropped. Chunks may end anywhere, inside a line or
 * inside a multi-byte character.
 */
import { z } from "zod";
import { PRODUCTS } from "../core/types.js";
import type { ToAdapter } from "../wire.js";

const toAdapter = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deliver"),
    id: z.string(),
    attempt: z.number().int(),
    to: z.object({ container: z.string(), product: z.enum(PRODUCTS), session: z.string() }),
    text: z.string(),
  }),
  z.object({ kind: z.literal("ping") }),
]);

export type SseState = {
  /** The bytes of a character that has not ended yet. */
  readonly pending: Uint8Array;
  /** The line that has not ended yet. */
  readonly line: string;
  /** The `data:` lines of the event being read. */
  readonly data: readonly string[];
};

export const emptySse: SseState = { pending: new Uint8Array(0), line: "", data: [] };

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** How many leading bytes are whole characters. */
function wholeLength(bytes: Uint8Array): number {
  const n = bytes.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const byte = bytes[n - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function parseEvent(data: readonly string[]): ToAdapter | null {
  if (data.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
  const parsed = toAdapter.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function feedSse(state: SseState, bytes: Uint8Array): { readonly state: SseState; readonly events: readonly ToAdapter[] } {
  const joined = concat(state.pending, bytes);
  const whole = wholeLength(joined);
  const text = state.line + decoder.decode(joined.subarray(0, whole));
  const events: ToAdapter[] = [];
  let data = state.data;
  let start = 0;
  for (const m of text.matchAll(/\r\n|\n|\r/g)) {
    // A lone CR at the very end may be the first half of CRLF: wait for the next chunk.
    if (m[0] === "\r" && m.index + 1 === text.length) break;
    const line = text.slice(start, m.index);
    start = m.index + m[0].length;
    if (line === "") {
      const event = parseEvent(data);
      if (event) events.push(event);
      data = [];
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      if (field === "data") {
        const value = colon === -1 ? "" : line.slice(colon + 1);
        data = [...data, value.startsWith(" ") ? value.slice(1) : value];
      }
    }
  }
  return { state: { pending: joined.slice(whole), line: text.slice(start), data }, events };
}
