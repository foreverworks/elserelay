/**
 * What the driver says to the Codex app-server and how it reads the answers.
 * Replies are parsed with zod and keep their unknown fields out of the way: the
 * server adds fields between releases and the driver reads only what it needs.
 */
import { z } from "zod";

/** Every method the driver may put on the wire. Nothing else is sent, and a test holds the driver to it. */
export const ALLOWED_METHODS = [
  "initialize",
  "initialized",
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "turn/start",
  "thread/queue/add",
] as const;
export type Method = (typeof ALLOWED_METHODS)[number];

export const isAllowedMethod = (method: string): method is Method => (ALLOWED_METHODS as readonly string[]).includes(method);

/** The server refuses `thread/queue/add` and other experimental calls without this declared at `initialize`. */
export const INITIALIZE_CAPABILITIES = { experimentalApi: true, requestAttestation: false } as const;

/** One JSON object per text frame, without a `jsonrpc` field. Requests from the server carry both `id` and `method`. */
export const frameSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
export type Frame = z.infer<typeof frameSchema>;

/** A status type the driver does not know is kept as text, so a new one reads as unknown and not as a parse failure. */
const statusSchema = z.object({ type: z.string() });

export const threadSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  /** Seconds since the epoch. */
  updatedAt: z.number(),
  status: statusSchema,
});
export type Thread = z.infer<typeof threadSchema>;

export const threadListSchema = z.object({ data: z.array(threadSchema) });
export const threadLoadedListSchema = z.object({ data: z.array(z.string()) });
export const threadReadSchema = z.object({ thread: threadSchema });
export const turnStartSchema = z.object({ turn: z.object({ id: z.string() }) });
export const queueAddSchema = z.object({ queuedSubmission: z.object({ id: z.string() }) });

/** A message is one text item. The empty `text_elements` is required by the server. */
export const textInput = (text: string) => [{ type: "text", text, text_elements: [] }] as const;

/** The server's wording for a thread id it has no record of, or cannot read as an id. */
export const isUnknownThreadMessage = (message: string): boolean => /^(thread not (found|loaded)|invalid thread id)/i.test(message);
