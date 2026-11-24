/**
 * `agent-gateway hook antigravity`: the command Antigravity runs before a model
 * call. It reads the hook's JSON on stdin, asks the broker what waits for that
 * conversation and prints it as steps to inject. Output shape and why this
 * way are in docs/drivers/antigravity.md.
 *
 * It must never slow or break the agent: the whole run, stdin included, has
 * `HOOK_TIMEOUT_MS`, and every failure (no broker, a slow one, a refused token,
 * bad input) prints nothing on stdout and returns 0.
 */
import { z } from "zod";
import { INBOX_PATH } from "../wire.js";
import type { InboxAnswer, InboxRequest } from "../wire.js";

export const HOOK_TIMEOUT_MS = 3000;

export type HookDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readStdin: () => Promise<string>;
  readonly readFile: (path: string) => Promise<string>;
  readonly fetch: typeof fetch;
  readonly out: (text: string) => void;
  readonly err: (line: string) => void;
  /** For tests; the default is `HOOK_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
};

const input = z.object({ conversationId: z.string().min(1).max(200) });
const answer = z.object({ messages: z.array(z.string()) });
const settings = z.object({ GATEWAY_URL: z.url(), GATEWAY_TOKEN_FILE: z.string().min(1) });

/** Settles with `promise`, or rejects when the signal fires first. */
function before<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("took longer than the hook may"));
    signal.addEventListener("abort", () => reject(new Error("took longer than the hook may")), { once: true });
    promise.then(resolve, reject);
  });
}

async function pull(deps: HookDeps, signal: AbortSignal): Promise<readonly string[]> {
  const config = settings.parse(Object.fromEntries(Object.entries(deps.env).filter(([, v]) => v !== undefined && v !== "")));
  let stdin: unknown;
  try {
    stdin = JSON.parse(await before(signal, deps.readStdin()));
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("stdin is not JSON");
  }
  const { conversationId } = input.parse(stdin);
  const token = (await before(signal, deps.readFile(config.GATEWAY_TOKEN_FILE))).trim();
  if (token === "") throw new Error("the token file is empty");

  const body: InboxRequest = { session: conversationId };
  const res = await deps.fetch(new URL(INBOX_PATH, config.GATEWAY_URL), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`the broker answered ${res.status}`);
  }
  const parsed: InboxAnswer = answer.parse(await before(signal, res.json()));
  return parsed.messages;
}

/** Always returns 0. */
export async function runAntigravityHook(deps: HookDeps): Promise<number> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? HOOK_TIMEOUT_MS);
  try {
    const messages = await pull(deps, signal);
    if (messages.length > 0) deps.out(JSON.stringify({ injectSteps: messages.map((userMessage) => ({ userMessage })) }));
  } catch (error) {
    // One line naming the failure, never a message text or the token. stdout stays empty.
    deps.err(`agent-gateway hook: ${error instanceof Error ? error.message.split("\n")[0] : "failed"}`);
  }
  return 0;
}
