# Antigravity: how a message gets in

Read on 2026-11-24 with agy 1.5.16 on Linux x86-64, without a login. What needs
one is marked unproven.

## The choice

The driver uses the documented hook with a mailbox. It does not push and it does
not wake an idle conversation. `agy agentapi` is not used, for the reason below.

## The hook (documented, unproven end to end)

[Hooks](https://antigravity.google/docs/hooks.md) are commands declared in
`.agents/hooks.json` or `~/.gemini/config/hooks.json`. They get JSON on stdin
with `conversationId` (and `workspacePaths`, `lastUserInput` and more), and have
30 seconds by default. Only `SessionStart`, `PreInvocation` (before each model
call) and `PostInvocation` can add to the conversation, through `injectSteps` on
stdout. Each step has one of these fields:

    {"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}
    {"injectSteps":[{"userMessage":"..."}]}

`userMessage` is a plain string, described as "a message from you";
`systemMessage` is an object. The page does not say how a hook's exit code is
read, and says that injected steps stay in the conversation.

`agent-gateway hook antigravity` is the command to register for `SessionStart` and
`PreInvocation`. It reads `conversationId` from stdin, calls the broker's
`POST /adapter/inbox` with `GATEWAY_URL` and the token in `GATEWAY_TOKEN_FILE`,
and prints one `userMessage` step for each waiting message, or nothing. It has
three seconds in all, and any failure (no broker, a slow one, a refused token,
bad stdin) prints nothing and exits 0.

**Which form to use is not settled.** The driver uses `userMessage`, the form the
docs describe as a message from the user. A
message from a peer is data and carries no authority of the person, so the form
that makes a model treat it with less authority is the better one. Which of the
two that is has to be measured against a logged-in agent; until then this is a
guess, and the rendered text says in its own words that it is data.

Delivery through the hook is at most once: the broker marks a message delivered
when it answers the hook, and a hook that dies after that loses it.

## `agy agentapi send-message`

- **Observed:** a gRPC client, calling
  `/exa.language_server_pb.LanguageServerService/SendAgentMessage` with the header
  `x-codeium-csrf-token`. Its address and token come only from
  `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN`; with no address it exits 1
  with `ANTIGRAVITY_LS_ADDRESS is not set`. The sender field stays empty.
- **Documented by the product's own skill:** agy sets the two variables only for
  commands its agent runs through the shell tool.
- A process outside can therefore use it only if something inside the conversation
  hands the token over. Having a model run a script that stores another process's
  token is not something this project does.
- **Unproven:** whether the server checks the token, and what a delivery does to an
  idle or a running conversation.

## `agy acp`

- **Observed:** `initialize` works without a login and offers session load, list,
  resume and close. `session/list` and `session/new` answer -32000
  `Authentication required`. It runs its own language server over the same files on
  disk, and does not attach to a running terminal's server.
- **Documented in the changelog:** `session/load` can attach to a running session.
- **Unproven:** that, and what two writers do to one conversation. If it holds, ACP
  is the way to wake a conversation.

## Listing

- **Observed:** `~/.gemini/antigravity-cli/conversation_summaries.db` (SQLite) has a
  table `conversation_summaries` with, among others, `conversation_id`, `title`,
  `last_modified_time`, `not_fully_idle` and `killed`. Its schema is not a
  documented contract. The driver opens it read-only and reads only those columns.
  It lists the 50 most recently changed conversations that are not killed: busy
  when `not_fully_idle` is set, cold after an hour without a change, unknown when
  the time cannot be read. A missing file, table or column is an empty list and one
  log line, not a crash. The database held no rows when it was read, so what `status` holds and
  how `last_modified_time` is written were not observed: `status` is not used, and the
  time is read as seconds, milliseconds or a date string.
- **Documented by the product's own skill:** `ListConversations`, which needs the
  address and the token.
