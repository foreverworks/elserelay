/**
 * `elserelay hook claude` and `elserelay hook codex`: a PreToolUse
 * command that fills the `session` argument of the gateway's tools with the
 * session id the product itself reports, so a model cannot mistype it or name
 * another session by accident. What this does and does not guarantee is in
 * docs/design.md (Identity); the settings that run it are in docs/hooks.md.
 *
 * It does no I/O besides stdin and stdout, so it costs nothing before a tool
 * call. Whatever goes wrong (stdin that is not JSON, no session id, a tool of
 * another server) it prints nothing and returns 0, and the call goes ahead
 * as the model wrote it.
 */

export type IdentityProduct = "claude" | "codex";

/** The gateway's tools that take a `session`. `list_peers` takes none, so there is nothing to fill in. */
export const SESSION_TOOLS: readonly string[] = ["send", "inbox", "reply"];
export const DEFAULT_SERVER = "elserelay";
/** The longest session id the tools accept (see the `session` argument in src/broker/tools.ts). */
const MAX_SESSION_CHARS = 200;
/** A hook's stdin may stay open; the agent is never kept waiting for it. */
export const STDIN_TIMEOUT_MS = 2000;

export type IdentityDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readStdin: () => Promise<string>;
  readonly out: (text: string) => void;
  /** For tests; the default is `STDIN_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The text of stdin, or an empty one when it did not arrive in time. */
function stdinWithin(read: () => Promise<string>, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(""), ms);
    timer.unref();
    read().then(
      (text) => {
        clearTimeout(timer);
        resolve(text);
      },
      () => {
        clearTimeout(timer);
        resolve("");
      },
    );
  });
}

/** Which gateway tool a hook's `tool_name` is, or null for any other tool (including another server's tool of the same name). */
export function gatewayTool(toolName: unknown, server: string): string | null {
  const prefix = `mcp__${server}__`;
  if (typeof toolName !== "string" || !toolName.startsWith(prefix)) return null;
  const tool = toolName.slice(prefix.length);
  return SESSION_TOOLS.includes(tool) ? tool : null;
}

/** The text to print for one hook call: a decision, or null when the call should go ahead untouched. */
export function decide(product: IdentityProduct, stdin: unknown, server: string): string | null {
  if (!isRecord(stdin) || gatewayTool(stdin.tool_name, server) === null) return null;
  const id = typeof stdin.session_id === "string" ? stdin.session_id.trim() : "";
  if (id === "" || id.length > MAX_SESSION_CHARS) return null;
  if (!isRecord(stdin.tool_input)) return null;
  const updatedInput = { ...stdin.tool_input, session: id };
  // Codex applies `updatedInput` only together with an allow. Claude Code is left to decide for itself.
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...(product === "codex" ? { permissionDecision: "allow" } : {}),
      updatedInput,
    },
  });
}

/** Always returns 0. */
export async function runIdentityHook(product: IdentityProduct, deps: IdentityDeps): Promise<number> {
  const server = deps.env.ELSERELAY_HOOK_SERVER?.trim() || DEFAULT_SERVER;
  const text = await stdinWithin(deps.readStdin, deps.timeoutMs ?? STDIN_TIMEOUT_MS);
  const output = decide(product, parse(text), server);
  if (output !== null) deps.out(output);
  return 0;
}
