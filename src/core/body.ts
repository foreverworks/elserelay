import { createHash } from "node:crypto";

/** What is kept of a body that is not kept: its length in characters and the SHA-256 of its UTF-8 bytes. */
export function bodyFacts(body: string): { readonly chars: number; readonly sha256: string } {
  return { chars: Array.from(body).length, sha256: createHash("sha256").update(body, "utf8").digest("hex") };
}
