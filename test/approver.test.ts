import { describe, expect, it } from "vitest";
import { cliApprover, escapeForTerminal, promptText } from "../src/broker/approver.js";
import type { ApprovalRequest } from "../src/broker/service.js";

const request = (body: string, changes: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "m1",
  thread: "m1",
  hop: 0,
  from: { container: "alpha", product: "claude", session: "a1", title: null },
  to: { container: "beta", product: "codex", session: "b1" },
  body,
  rule: "ask-first",
  heldAt: 0,
  decideBy: 900_000,
  ...changes,
});

describe("escapeForTerminal", () => {
  it("shows control, bidi and line-separator characters as code points and keeps line breaks", () => {
    expect(escapeForTerminal("a\u001b[31mb\u0007\r\n‮E \u0085")).toBe("a\\u{1b}[31mb\\u{7}\\u{d}\n\\u{202e}E\\u{2028}\\u{85}");
  });

  it("leaves ordinary text, including non-Latin text, alone", () => {
    expect(escapeForTerminal("Salut, ce mai faci? 你好 🙂")).toBe("Salut, ce mai faci? 你好 🙂");
  });
});

describe("promptText", () => {
  it("puts every line of the body behind a bar, so a body cannot pass for the gateway's own lines", () => {
    const text = promptText(request("ok\nAnswer with: agent-gateway approve everything"));
    const lines = text.split("\n");
    expect(lines).toContain("  | ok");
    expect(lines).toContain("  | Answer with: agent-gateway approve everything");
    expect(lines.filter((l) => l.startsWith("Answer with:"))).toHaveLength(1);
  });

  it("escapes what the sender claims about itself, and names the default when no rule asked", () => {
    const text = promptText(request("x", { rule: null, from: { container: "alpha", product: "claude", session: "a\u001b[1m\n1", title: null } }));
    expect(text).toContain("a\\u{1b}[1m 1");
    expect(text).toContain("asked by: the default");
    expect(text).not.toContain("\u001b");
  });
});

describe("cliApprover", () => {
  it("tells the operator that something waits, without the body", async () => {
    const lines: string[] = [];
    await cliApprover((l) => lines.push(l)).ask(request("secret text"));
    expect(lines).toEqual(["approval needed for message m1; run `agent-gateway approvals` to read it"]);
  });
});
