/** The one real socket: WebSocket over a Unix socket, text frames only. */
import WebSocket from "ws";
import type { Connect } from "./connection.js";

const HANDSHAKE_TIMEOUT_MS = 5000;

export const connectUnix =
  (path: string): Connect =>
  (handlers) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://${path}:/`, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
      // An error after the socket opened is followed by a close, which is what the driver acts on.
      ws.on("error", reject);
      ws.on("message", (data, isBinary) => {
        if (!isBinary) handlers.message(data.toString());
      });
      ws.on("close", (code) => handlers.close(`code ${code}`));
      ws.on("open", () => resolve({ send: (text) => ws.send(text), close: () => ws.close() }));
    });
