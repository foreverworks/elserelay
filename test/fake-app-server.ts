/**
 * A stand-in for the Codex app-server: WebSocket over a Unix socket in a temp
 * dir, one JSON object per text frame, `initialize` required before anything else.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

export type Answer =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }
  /** Say nothing. */
  | "hang"
  /** Close the connection without an answer. */
  | "drop";

export type Handler = (params: unknown) => Answer | Promise<Answer>;

export type Frame = { readonly id?: number; readonly method?: string; readonly params?: unknown; readonly result?: unknown; readonly error?: unknown };

export type FakeServer = {
  readonly path: string;
  /** Every frame a client sent, in order, notifications and answers included. */
  readonly received: Frame[];
  readonly methods: () => string[];
  /** Closes every open connection; the server keeps listening. */
  readonly dropClients: () => void;
  /** Sends a request of the server's own to every client. */
  readonly sendRequest: (method: string, params: unknown) => void;
  /** Sends text to every client as it is. */
  readonly sendRaw: (text: string) => void;
  readonly close: () => Promise<void>;
};

export const notInitialized = { error: { code: -32600, message: "Not initialized" } } as const;

export const startFakeServer = async (handlers: Readonly<Record<string, Handler>>): Promise<FakeServer> => {
  const dir = await mkdtemp(join(tmpdir(), "elserelay-codex-"));
  const path = join(dir, "app-server.sock");
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const received: Frame[] = [];
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    let initialized = false;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      received.push(frame);
      if (frame.method === undefined || frame.id === undefined) return;
      const reply = (answer: object) => ws.send(JSON.stringify({ id: frame.id, ...answer }));
      if (frame.method === "initialize") {
        if (initialized) return reply({ error: { code: -32600, message: "Already initialized" } });
        initialized = true;
        return reply({ result: { userAgent: "fake", codexHome: dir, platformFamily: "unix", platformOs: "linux" } });
      }
      if (!initialized) return reply(notInitialized);
      const handler = handlers[frame.method];
      if (handler === undefined) return reply({ error: { code: -32601, message: `method not found: ${frame.method}` } });
      void (async () => {
        const answer = await handler(frame.params);
        if (answer === "hang") return;
        if (answer === "drop") return ws.close();
        reply(answer);
      })();
    });
  });

  await new Promise<void>((resolve) => http.listen(path, resolve));

  return {
    path,
    received,
    methods: () => received.flatMap((frame) => (frame.method === undefined ? [] : [frame.method])),
    dropClients: () => {
      for (const ws of clients) ws.terminate();
    },
    sendRequest: (method, params) => {
      for (const ws of clients) ws.send(JSON.stringify({ id: 9001, method, params }));
    },
    sendRaw: (text) => {
      for (const ws of clients) ws.send(text);
    },
    close: async () => {
      for (const ws of clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
};

export const thread = (id: string, status: unknown, extra: Readonly<Record<string, unknown>> = {}) => ({
  id,
  name: null,
  updatedAt: 1_800_000_000,
  status,
  // Fields the driver does not read; the server sends many more.
  preview: "hello",
  modelProvider: "openai",
  ...extra,
});
