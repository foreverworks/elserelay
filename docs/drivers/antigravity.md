# Antigravity: how a message gets in

Read on 2026-11-24 with agy 1.5.16 on Linux x86-64, without a login. What needs
one is marked unproven.

## The choice

The driver uses the documented hook with a mailbox. It does not push and it does
not wake an idle conversation. `agy agentapi` is not used, for the reason below.

## The hook (documented, unproven end to end)

[Hooks](https://antigravity.google/docs/hooks.md) are commands declared in
`.agents/hooks.json` or `~/.gemini/config/hooks.json`. They get JSON on stdin,
with `conversationId`, and have 30 seconds by default. `SessionStart`,
`PreInvocation` (before each model call) and `PostInvocation` can add to the
conversation:

    {"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}

`userMessage` is the other form. A message from a peer is data, so which of the
two carries less authority has to be measured before one is chosen. The hook reads
the conversation's mailbox and hands over what waits there.

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
  table `conversation_summaries` with the id, title, status, workspace and last
  change. Its schema is not a documented contract.
- **Documented by the product's own skill:** `ListConversations`, which needs the
  address and the token.
