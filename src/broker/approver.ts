import type { ApprovalRequest } from "./service.js";

/**
 * Starts asking a person. The answer does not come back through here: whoever
 * answers calls the service's `approve` or `refuse`. The approver never holds
 * a token, only the request.
 */
export type Approver = {
  readonly ask: (request: ApprovalRequest) => Promise<void>;
};

/**
 * Text that is safe to print to a terminal: every control and invisible
 * formatting character (an escape sequence, a bidi override, a carriage
 * return that rewrites a line) is shown as `\u{..}` instead of acting.
 * A line break stays a line break.
 */
export function escapeForTerminal(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => (char === "\n" ? char : `\\u{${char.codePointAt(0)?.toString(16) ?? "0"}}`));
}

const isoTime = (at: number): string => new Date(at).toISOString();

/**
 * What a person reads before deciding. The sender's own words are indented
 * under a bar, so no line of them can pass for a line of the gateway's.
 */
export function promptText(request: ApprovalRequest): string {
  const who = (a: { readonly container: string; readonly product: string; readonly session: string }): string =>
    escapeForTerminal(`${a.container} / ${a.product} / ${a.session}`).replace(/\n/g, " ");
  const body = escapeForTerminal(request.body)
    .split("\n")
    .map((line) => `  | ${line}`);
  return [
    `Message ${request.id} is waiting for you`,
    `  from: ${who(request.from)}`,
    `  to:   ${who(request.to)}`,
    `  asked by: ${request.rule === null ? "the default" : escapeForTerminal(`rule "${request.rule}"`).replace(/\n/g, " ")}`,
    `  answer by: ${isoTime(request.decideBy)}`,
    `  text:`,
    ...body,
    `Answer with: agent-gateway approve ${request.id}   or   agent-gateway refuse ${request.id}`,
  ].join("\n");
}

/**
 * The default approver: it tells the operator on stderr that something waits and
 * leaves the text for `agent-gateway approvals`, so a message body never lands in a journal.
 */
export function cliApprover(log: (line: string) => void): Approver {
  return {
    ask: (request) => {
      log(`approval needed for message ${request.id}; run \`agent-gateway approvals\` to read it`);
      return Promise.resolve();
    },
  };
}
