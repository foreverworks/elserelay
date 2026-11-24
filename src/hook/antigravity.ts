/**
 * `elserelay hook antigravity`: the command Antigravity runs before a model
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
const answer = z.object({ messages: z.array(z.object({ id: z.string(), text: z.string() })) });
const settings = z.object({ ELSERELAY_URL: z.url(), ELSERELAY_TOKEN_FILE: z.string().min(1) });

/** Settles with `promise`, or rejects when the signal fires first. */
function before<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("took longer than the hook may"));
    signal.addEventListener("abort", () => reject(new Error("took longer than the hook may")), { once: true });
    promise.then(resolve, reject);
  });
}

type Pulled = { readonly messages: InboxAnswer["messages"]; readonly acknowledge: () => Promise<void> };

async function pull(deps: HookDeps, signal: AbortSignal): Promise<Pulled> {
  const config = settings.parse(Object.fromEntries(Object.entries(deps.env).filter(([, v]) => v !== undefined && v !== "")));
  let stdin: unknown;
  try {
    stdin = JSON.parse(await before(signal, deps.readStdin()));
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("stdin is not JSON");
  }
  const { conversationId } = input.parse(stdin);
  const token = (await before(signal, deps.readFile(config.ELSERELAY_TOKEN_FILE))).trim();
  if (token === "") throw new Error("the token file is empty");

  const post = (body: InboxRequest): Promise<Response> =>
    deps.fetch(new URL(INBOX_PATH, config.ELSERELAY_URL), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  const res = await post({ session: conversationId });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`the broker answered ${res.status}`);
  }
  const parsed: InboxAnswer = answer.parse(await before(signal, res.json()));
  const received = parsed.messages.map((m) => m.id);
  return {
    messages: parsed.messages,
    acknowledge: async () => {
      const done = await post({ session: conversationId, received, acknowledgeOnly: true });
      await done.body?.cancel();
    },
  };
}

/** Always returns 0. */
export async function runAntigravityHook(deps: HookDeps): Promise<number> {
  const signal = AbortSignal.timeout(deps.timeoutMs ?? HOOK_TIMEOUT_MS);
  let pulled: Pulled;
  try {
    pulled = await pull(deps, signal);
    if (pulled.messages.length > 0) deps.out(JSON.stringify({ injectSteps: pulled.messages.map((m) => ({ userMessage: m.text })) }));
  } catch (error) {
    // One line naming the failure, never a message text or the token. stdout stays empty.
    deps.err(`elserelay hook: ${error instanceof Error ? error.message.split("\n")[0] : "failed"}`);
    return 0;
  }
  // Only after the text has been written is it known to have left; a failure here is ignored, and the broker returns the messages later.
  if (pulled.messages.length > 0) await pulled.acknowledge().catch(() => undefined);
  return 0;
}
