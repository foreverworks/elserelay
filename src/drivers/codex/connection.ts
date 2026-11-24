/**
 * One request at a time per id over a socket the driver can lose: matching of
 * replies to requests, a timeout on each, and a new socket on the first call
 * after a close. The socket itself is passed in.
 */
import { frameSchema, isAllowedMethod, INITIALIZE_CAPABILITIES, type Method } from "./wire.js";

export type Socket = {
  readonly send: (text: string) => void;
  readonly close: () => void;
};

export type Handlers = {
  readonly message: (text: string) => void;
  readonly close: (reason: string) => void;
};

/** Opens a socket and resolves once it can send; rejects when it cannot be opened. */
export type Connect = (handlers: Handlers) => Promise<Socket>;

/**
 * Why a call has no answer. `connect`: nothing was sent. `closed` and
 * `timeout`: the request went out and the outcome is not known. `rpc`: the
 * server answered with an error, so it did not act on the request.
 */
export type Failure =
  | { readonly kind: "connect"; readonly detail: string }
  | { readonly kind: "closed"; readonly detail: string }
  | { readonly kind: "timeout"; readonly detail: string }
  | { readonly kind: "rpc"; readonly code: number; readonly message: string };

export type Reply = { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly failure: Failure };

export type Connection = {
  readonly call: (method: Method, params: unknown, timeoutMs?: number) => Promise<Reply>;
  readonly close: () => void;
};

export type ConnectionOptions = {
  readonly connect: Connect;
  readonly timeoutMs: number;
  readonly clientInfo: { readonly name: string; readonly title: string | null; readonly version: string };
};

type Link = { readonly token: symbol; readonly socket: Socket };
type Pending = { readonly token: symbol; readonly settle: (reply: Reply) => void };

const failed = (failure: Failure): Reply => ({ ok: false, failure });
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createConnection = (options: ConnectionOptions): Connection => {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let current: Link | null = null;
  let opening: Promise<Link | Reply> | null = null;

  const failLink = (token: symbol, reason: string): void => {
    if (current?.token === token) current = null;
    for (const [id, entry] of [...pending]) {
      if (entry.token !== token) continue;
      pending.delete(id);
      entry.settle(failed({ kind: "closed", detail: `connection closed (${reason}) before the server answered` }));
    }
  };

  const onMessage = (text: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = frameSchema.safeParse(raw);
    // A frame with a method is a notification or a request from the server. Requests are never answered.
    if (!parsed.success || parsed.data.id === undefined || parsed.data.method !== undefined) return;
    const id = typeof parsed.data.id === "number" ? parsed.data.id : Number.NaN;
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    const { error, result } = parsed.data;
    entry.settle(error === undefined ? { ok: true, result } : failed({ kind: "rpc", code: error.code, message: error.message }));
  };

  const frame = (method: Method, params: unknown, id?: number): string =>
    JSON.stringify(id === undefined ? { method, ...(params === undefined ? {} : { params }) } : { id, method, params });

  const request = (link: Link, method: Method, params: unknown, timeoutMs: number): Promise<Reply> => {
    if (!isAllowedMethod(method)) return Promise.resolve(failed({ kind: "connect", detail: `method ${method} is not allowed` }));
    const id = nextId++;
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve(failed({ kind: "timeout", detail: `no answer to ${method} within ${timeoutMs} ms` }));
      }, timeoutMs);
      pending.set(id, {
        token: link.token,
        settle: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
      });
      try {
        link.socket.send(frame(method, params, id));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        if (current?.token === link.token) current = null;
        resolve(failed({ kind: "connect", detail: `could not send ${method}: ${describe(error)}` }));
      }
    });
  };

  const open = async (): Promise<Link | Reply> => {
    const token = Symbol("link");
    let socket: Socket;
    try {
      socket = await options.connect({ message: onMessage, close: (reason) => failLink(token, reason) });
    } catch (error) {
      return failed({ kind: "connect", detail: `could not connect: ${describe(error)}` });
    }
    const link: Link = { token, socket };
    const hello = await request(link, "initialize", { clientInfo: options.clientInfo, capabilities: INITIALIZE_CAPABILITIES }, options.timeoutMs);
    if (!hello.ok) {
      socket.close();
      failLink(token, "initialize failed");
      const why = hello.failure.kind === "rpc" ? hello.failure.message : hello.failure.detail;
      return failed({ kind: "connect", detail: `initialize failed: ${why}` });
    }
    try {
      socket.send(frame("initialized", undefined));
    } catch (error) {
      socket.close();
      return failed({ kind: "connect", detail: `could not send initialized: ${describe(error)}` });
    }
    current = link;
    return link;
  };

  const ready = async (): Promise<Link | Reply> => {
    if (current !== null) return current;
    opening ??= open().finally(() => {
      opening = null;
    });
    return opening;
  };

  return {
    call: async (method, params, timeoutMs = options.timeoutMs) => {
      const link = await ready();
      if ("ok" in link) return link;
      return request(link, method, params, timeoutMs);
    },
    close: () => {
      const link = current;
      current = null;
      if (link === null) return;
      link.socket.close();
      failLink(link.token, "closed by the driver");
    },
  };
};
