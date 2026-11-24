# Codex: how a message gets in

Read on 2026-11-24 with codex-cli 0.172.0 on Linux x64, without a login: the types
come from `codex app-server generate-ts --experimental`, and what is marked observed
was run against a private `CODEX_HOME`. What needs a login is marked unproven.

## The choice

The driver is a second client of the app-server the agent already runs.

- Idle thread: `turn/start`. The server answers with the turn, so the driver can
  claim `confirmed`.
- Busy thread: `thread/queue/add`, so a message waits for the running turn instead
  of joining it.
- The driver never calls `thread/resume`, `thread/shellCommand` or
  `thread/inject_items`, sends no per-turn overrides (model, sandbox, approvals),
  and never answers an approval request.

## The socket

- **Observed:** `codex app-server --listen unix://` makes
  `$CODEX_HOME/app-server-control/app-server-control.sock`, a symlink into
  `/tmp/codex-daemon-<uid>/` (directory 700, socket 600). A process with another
  `/tmp` cannot follow it; an explicit `unix://PATH` avoids that.
- **Observed:** WebSocket over the Unix socket, one JSON object per text frame,
  without a `jsonrpc` field: `{id, method, params}`, `{id, result}` or
  `{id, error: {code, message}}`, `{method, params}`.
- **Observed:** nothing authenticates on it beyond file permissions, and a client is
  known only by the `clientInfo` it declares. `thread/shellCommand` from a second
  client ran an unsandboxed command in the first one's thread. Whoever holds this
  socket holds the agent, so it stays inside the agent's container.

## The calls

- **Observed:** `initialize` with `{clientInfo: {name, title, version},
  capabilities}`, then the notification `initialized`. Before it every request
  fails with -32600 `Not initialized`. `thread/queue/add` also fails with -32600
  `requires experimentalApi capability` unless `initialize` declared
  `capabilities: {experimentalApi: true, requestAttestation: false}`.
- **Observed:** a thread id the server has never seen fails `thread/read` with -32600
  `thread not loaded: <id>` (not a `notLoaded` status) and `turn/start` with -32600
  `thread not found: <id>`; a malformed id fails with `invalid thread id: ...`. The
  driver reads all three as an unknown thread.
- **Observed:** `thread/list` gives persisted threads; a new one appears after its
  first message. `thread/loaded/list` gives the ids in memory, also those another
  client started.
- **Schema:** a thread's status is `notLoaded`, `idle`, `systemError` or `active`
  (with `waitingOnApproval` or `waitingOnUserInput`).
- **Observed:** `turn/start` with `{threadId, input: [{type: "text", text,
  text_elements: []}]}` on a thread the client did not start returned a turn
  `inProgress`. Called while a turn ran, it returned the same turn and appended the
  text, so the status has to be read first, and a thread can become busy between the
  two calls.
- **Observed:** `thread/queue/add` worked from a client that did not start the
  thread.
- **Observed:** a client that has not called `thread/resume` gets `thread/started`,
  `thread/status/changed` and `thread/readState/changed`, and no turn or item events.

## Unproven

Needs a login: a turn that completes, what the queue does when the running turn ends,
delivery into a thread the interactive CLI created, and which client receives an
approval request when several are connected.
