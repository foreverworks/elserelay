import { describe, expect, it } from "vitest";
import { emptySse, feedSse } from "../src/adapter/sse.js";
import type { ToAdapter } from "../src/wire.js";

const enc = new TextEncoder();

function feedAll(chunks: readonly Uint8Array[]): ToAdapter[] {
  let state = emptySse;
  const out: ToAdapter[] = [];
  for (const c of chunks) {
    const r = feedSse(state, c);
    state = r.state;
    out.push(...r.events);
  }
  return out;
}

const deliver = (text: string): ToAdapter => ({
  kind: "deliver",
  id: "m1",
  attempt: 1,
  to: { container: "a", product: "claude", session: "s1" },
  text,
});

const frame = (v: unknown): string => `data: ${JSON.stringify(v)}\n\n`;

describe("feedSse", () => {
  it("reads a deliver and a ping", () => {
    const text = frame(deliver("hi")) + frame({ kind: "ping" });
    expect(feedAll([enc.encode(text)])).toEqual([deliver("hi"), { kind: "ping" }]);
  });

  it("gives the same events for every split of the bytes", () => {
    const bytes = enc.encode(frame(deliver("héllo \u{1F600} wörld")) + ": keep-alive\n\n" + frame({ kind: "ping" }));
    const whole = feedAll([bytes]);
    expect(whole).toHaveLength(2);
    for (let i = 1; i < bytes.length; i++) {
      expect(feedAll([bytes.subarray(0, i), bytes.subarray(i)])).toEqual(whole);
    }
  });

  it("works one byte at a time, also with multi-byte characters", () => {
    const bytes = enc.encode(frame(deliver("日本語 \u{1F600}")));
    const events = feedAll(Array.from(bytes, (b) => Uint8Array.of(b)));
    expect(events).toEqual([deliver("日本語 \u{1F600}")]);
  });

  it("ignores comments and other fields", () => {
    const text = `: hello\nevent: x\nid: 7\nretry: 100\ndata: ${JSON.stringify({ kind: "ping" })}\n\n`;
    expect(feedAll([enc.encode(text)])).toEqual([{ kind: "ping" }]);
  });

  it("ignores unknown kinds, bad JSON and a deliver with the wrong shape", () => {
    const text =
      frame({ kind: "future" }) +
      "data: {not json\n\n" +
      frame({ kind: "deliver", id: 3 }) +
      frame({ kind: "deliver", id: "x", attempt: 1, to: { container: "a", product: "nope", session: "s" }, text: "t" }) +
      frame({ kind: "ping" });
    expect(feedAll([enc.encode(text)])).toEqual([{ kind: "ping" }]);
  });

  it("joins several data lines of one event with a newline", () => {
    const json = JSON.stringify(deliver("a\nb"), null, 1);
    const text = json.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n";
    expect(feedAll([enc.encode(text)])).toEqual([deliver("a\nb")]);
  });

  it("accepts CRLF and CR line ends, also when CR and LF arrive in different chunks", () => {
    const line = JSON.stringify({ kind: "ping" });
    expect(feedAll([enc.encode(`data: ${line}\r\n\r\n`)])).toHaveLength(1);
    // A CR at the very end waits for a possible LF, so the next bytes release the event.
    expect(feedAll([enc.encode(`data: ${line}\r\r`), enc.encode(": next\n")])).toHaveLength(1);
    expect(feedAll([enc.encode(`data: ${line}\r`), enc.encode("\n\r"), enc.encode("\n")])).toHaveLength(1);
  });

  it("does not emit an event that has no blank line yet", () => {
    expect(feedAll([enc.encode(`data: ${JSON.stringify({ kind: "ping" })}\n`)])).toEqual([]);
  });

  it("takes a data line with no space after the colon", () => {
    expect(feedAll([enc.encode(`data:${JSON.stringify({ kind: "ping" })}\n\n`)])).toEqual([{ kind: "ping" }]);
  });
});
