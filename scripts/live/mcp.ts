/** A client of the broker's MCP endpoint, as a container's agent would use it. */
import { StreamableHTTPClientTransport, testClient } from "@foreverworks/mcp-kit";
import type { Client } from "@foreverworks/mcp-kit";
import { record } from "./util.ts";

export type Answer = { readonly isError: boolean; readonly text: string; readonly json: Record<string, unknown> };
export type Peer = { readonly container: string; readonly session: string; readonly needsApproval: boolean };

export async function connectClient(mcpPort: number, label: string, token: string): Promise<Client> {
  const client = testClient(label);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Answer> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((c) => (typeof record(c)?.["text"] === "string" ? String(record(c)?.["text"]) : "")).join("\n");
  let json: Record<string, unknown> = {};
  try {
    json = record(JSON.parse(text)) ?? {};
  } catch {
    // An error answer is plain text.
  }
  return { isError: result.isError === true, text, json };
}

export async function listPeers(mcpPort: number, label: string, token: string): Promise<Peer[]> {
  const client = await connectClient(mcpPort, label, token);
  const answer = await callTool(client, "list_peers", {});
  await client.close();
  const list = answer.json["peers"];
  return Array.isArray(list) ? list.map((p) => ({ container: String(record(p)?.["container"]), session: String(record(p)?.["session"]), needsApproval: record(p)?.["needsApproval"] === true })) : [];
}
