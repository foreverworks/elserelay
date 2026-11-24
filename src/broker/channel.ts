/**
 * The adapters' side of the broker: three routes on a port of their own,
 * the shapes of which are in `src/wire.ts`.
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clientFor, pathnameOf, plainReply, readRawBody } from "@foreverworks/mcp-kit";
import type { ClientTokens } from "@foreverworks/mcp-kit";
import { z } from "zod";
import { PRODUCTS } from "../core/types.js";
import { INBOX_PATH, OUTCOME_PATH, REPORT_PATH, STREAM_PATH } from "../wire.js";
import type { AdapterReport, InboxAnswer, InboxRequest, Outcome, ToAdapter } from "../wire.js";
import type { Service } from "./service.js";

/** Runs `fn` every `ms` until the returned function is called. The only timer the broker needs. */
export type Every = (ms: number, fn: () => void) => () => void;

export const MAX_BODY_BYTES = 1024 * 1024;
export const PING_MS = 20_000;

const text = z.string().min(1).max(200);
const certainty = z.enum(["confirmed", "accepted"]);

const reportSchema = z.strictObject({
  product: z.enum(PRODUCTS),
  capabilities: z.strictObject({ push: z.boolean(), wakesIdle: z.boolean(), joinsTurn: z.boolean(), certainty }),
  sessions: z
    .array(z.strictObject({ session: text, title: z.string().max(200).nullable(), activity: z.enum(["idle", "busy", "cold", "unknown"]) }))
    .max(1000),
});

const outcomeSchema = z.strictObject({
  id: z.string().min(1).max(200),
  attempt: z.number().int().min(1),
  result: z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), certainty }),
    z.strictObject({ ok: z.literal(false), retry: z.boolean(), detail: z.string().max(2000) }),
  ]),
});

const inboxSchema = z.strictObject({ session: text });

export type Channel = {
  readonly handle: (req: IncomingMessage, res: ServerResponse) => void;
  /** Pushes what is deliverable to the container's open stream, if it has one. */
  readonly pump: (container: string) => void;
  readonly pumpAll: () => void;
  readonly connected: () => readonly string[];
  readonly close: () => void;
};

export type ChannelDeps = {
  readonly service: Service;
  readonly tokens: ClientTokens;
  readonly every: Every;
  readonly pingMs?: number;
  readonly maxBodyBytes?: number;
};

type Stream = { readonly res: ServerResponse; readonly stop: () => void };

const frame = (event: ToAdapter): string => `data: ${JSON.stringify(event)}\n\n`;

export function makeChannel(deps: ChannelDeps): Channel {
  const { service, tokens, every } = deps;
  const pingMs = deps.pingMs ?? PING_MS;
  const maxBody = deps.maxBodyBytes ?? MAX_BODY_BYTES;
  const streams = new Map<string, Stream>();

  const write = (stream: Stream, event: ToAdapter): void => {
    if (!stream.res.writableEnded && !stream.res.destroyed) stream.res.write(frame(event));
  };

  const drop = (container: string, stream: Stream): void => {
    stream.stop();
    if (streams.get(container) === stream) {
      streams.delete(container);
      service.streamClosed(container);
    }
  };

  const pump = (container: string): void => {
    const stream = streams.get(container);
    if (stream === undefined) return;
    for (const h of service.nextFor(container)) write(stream, { kind: "deliver", id: h.id, attempt: h.attempt, to: h.to, text: h.text });
  };

  function openStream(container: string, req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": open\n\n");
    const previous = streams.get(container);
    const stream: Stream = { res, stop: every(pingMs, () => write(stream, { kind: "ping" })) };
    streams.set(container, stream);
    service.streamOpened(container);
    // A second stream from the same container replaces the first: the adapter that dialled again is the live one.
    if (previous !== undefined) {
      previous.stop();
      previous.res.end();
    }
    req.on("close", () => drop(container, stream));
    res.on("close", () => drop(container, stream));
    pump(container);
  }

  async function readJson<T>(req: IncomingMessage, res: ServerResponse, schema: z.ZodType<T>): Promise<T | undefined> {
    const raw = await readRawBody(req, maxBody, 15_000);
    if (!raw.ok) {
      plainReply(res, raw.status, raw.status === 413 ? "body too large" : "bad request");
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.body.toString("utf8"));
    } catch {
      plainReply(res, 400, "body is not JSON");
      return undefined;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      plainReply(res, 400, "body does not match the expected shape");
      return undefined;
    }
    return parsed.data;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = pathnameOf(req.url);
    if (path !== STREAM_PATH && path !== REPORT_PATH && path !== OUTCOME_PATH && path !== INBOX_PATH) return plainReply(res, 404, "not found");

    const container = clientFor(req.headers.authorization, tokens);
    if (container === undefined) return plainReply(res, 401, "a bearer token is required", { "www-authenticate": "Bearer" });
    // A valid token whose label the config does not know: authenticated, but not a container of this gateway.
    if (service.productOf(container) === undefined) return plainReply(res, 403, "this token's container is not configured");

    if (path === STREAM_PATH) {
      if (req.method !== "GET") return plainReply(res, 405, "use GET", { allow: "GET" });
      return openStream(container, req, res);
    }
    if (req.method !== "POST") return plainReply(res, 405, "use POST", { allow: "POST" });

    if (path === REPORT_PATH) {
      const body = await readJson(req, res, reportSchema);
      if (body === undefined) return;
      const report: AdapterReport = body;
      const result = service.report(container, report);
      if (result.kind !== "ok") return plainReply(res, 403, "this token's container runs another product");
      res.writeHead(204).end();
      pump(container);
      return;
    }

    if (path === INBOX_PATH) {
      const body = await readJson(req, res, inboxSchema);
      if (body === undefined) return;
      const request: InboxRequest = body;
      const result = service.inbox(container, request.session);
      if (result.kind !== "ok") return plainReply(res, 403, "this token's container is not configured");
      const answer: InboxAnswer = { messages: result.messages.map((m) => m.text) };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(answer));
      return;
    }

    const body = await readJson(req, res, outcomeSchema);
    if (body === undefined) return;
    const outcome: Outcome = body;
    service.outcome(container, outcome);
    res.writeHead(204).end();
    pump(container);
  }

  return {
    handle: (req, res) => {
      route(req, res).catch(() => {
        if (!res.headersSent) plainReply(res, 500, "internal error");
        else res.end();
      });
    },
    pump,
    pumpAll: () => [...streams.keys()].forEach(pump),
    connected: () => [...streams.keys()],
    close: () => {
      for (const [container, stream] of [...streams]) {
        drop(container, stream);
        stream.res.end();
      }
    },
  };
}

export type Listening = { readonly port: number; readonly close: () => Promise<void> };

/** Binds the configured address only; port 0 picks a free one. */
export function listen(channel: Channel, host: string, port: number): Promise<Listening> {
  const server = createServer(channel.handle);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("the adapter channel has no TCP address"));
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            channel.close();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
