/** Bearer tokens: one random secret per container, in a file only this user can read. */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeTokens(dir: string, labels: readonly string[]): Map<string, string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokens = new Map<string, string>(labels.map((label) => [label, randomBytes(24).toString("hex")]));
  for (const [label, token] of tokens) {
    writeFileSync(tokenFile(dir, label), token, { mode: 0o600 });
    chmodSync(tokenFile(dir, label), 0o600);
  }
  return tokens;
}

export const tokenFile = (dir: string, label: string): string => join(dir, `token-${label}`);

export const removeTokens = (dir: string): void => rmSync(dir, { recursive: true, force: true });
