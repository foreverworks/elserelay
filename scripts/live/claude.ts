/** A real, throwaway Claude Code session driven over stream-json, with only the gateway's four tools. */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { record } from "./util.ts";

export const ELSERELAY_TOOLS = ["list_peers", "send", "inbox", "reply"] as const;

export type Turn = { readonly text: string; readonly isError: boolean; readonly cost: number };
export type ToolCall = { readonly name: string; readonly input: unknown };

export type Session = {
  readonly name: string;
  readonly id: string;
  readonly pid: number;
  readonly turns: Turn[];
  readonly calls: ToolCall[];
  readonly prompt: (text: string) => void;
  /** The cost the session reports for itself, which is a running total. */
  readonly cost: () => number;
  readonly close: () => void;
};

export type SessionOptions = {
  readonly claude: string;
  readonly model: string;
  readonly name: string;
  readonly id: string;
  readonly mcpConfig: string;
  readonly cwd: string;
  readonly log: string;
  readonly children: ChildProcess[];
  readonly onTurn: () => void;
};

/** An MCP config file (mode 0600) that names only this gateway and one container's bearer. */
export function writeMcpConfig(path: string, mcpPort: number, token: string): string {
  const config = { mcpServers: { elserelay: { type: "http", url: `http://127.0.0.1:${mcpPort}/mcp`, headers: { Authorization: `Bearer ${token}` } } } };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

export function startSession(o: SessionOptions): Session {
  const allowed = ELSERELAY_TOOLS.map((tool) => `mcp__elserelay__${tool}`).join(",");
  const child = spawn(
    o.claude,
    [
      "-p",
      "--model", o.model,
      "--session-id", o.id,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config", o.mcpConfig,
      "--tools", "",
      "--allowedTools", allowed,
    ],
    { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"] },
  );
  o.children.push(child);
  const turns: Turn[] = [];
  const calls: ToolCall[] = [];
  let cost = 0;
  const out = createWriteStream(o.log);
  child.stderr.pipe(createWriteStream(`${o.log}.err`));
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      out.write(`${line}\n`);
      let event: Record<string, unknown> | null = null;
      try {
        event = record(JSON.parse(line));
      } catch {
        continue;
      }
      if (event === null) continue;
      if (event["type"] === "assistant") {
        const content = record(event["message"])?.["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = record(block);
            if (b !== null && b["type"] === "tool_use" && typeof b["name"] === "string") calls.push({ name: b["name"], input: b["input"] });
          }
        }
      }
      if (event["type"] === "result") {
        const total = typeof event["total_cost_usd"] === "number" ? event["total_cost_usd"] : 0;
        cost = Math.max(cost, total);
        turns.push({ text: typeof event["result"] === "string" ? event["result"] : "", isError: event["is_error"] === true, cost: total });
        o.onTurn();
      }
    }
  });
  return {
    name: o.name,
    id: o.id,
    pid: child.pid ?? 0,
    turns,
    calls,
    prompt: (text) => {
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    },
    cost: () => cost,
    close: () => child.stdin.end(),
  };
}

export const toolsCalled = (s: Session, tool: string): ToolCall[] => s.calls.filter((c) => c.name === `mcp__elserelay__${tool}`);

export function versionOf(binary: string): Promise<string> {
  return new Promise((done) => {
    execFile(binary, ["--version"], { encoding: "utf8" }, (_error, stdout) => done(stdout.trim() || "unknown"));
  });
}
