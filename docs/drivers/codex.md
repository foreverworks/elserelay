# Codex: how a message gets in

Read on 2026-11-24 with codex-cli 0.172.0 on Linux x64. The types come from
`codex app-server generate-ts --experimental`. What is marked observed was run against
a real app-server: first without a login in a private `CODEX_HOME`, then with a signed-in
home in the live run of `docs/live.md` (part two), which names the model and the runs.
What no run has shown is under Unproven.

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

## What the live run showed

Each line is one observation from the runs in `docs/live.md`, part two. A thread there
had the approval policy `untrusted` and a read-only sandbox, and the app-server was
started with `-c` options that add the gateway as an MCP server.

- **Observed:** the gateway as an MCP server of the app-server works from `-c` options
  alone, with `mcp_servers.<name>.url`, `bearer_token_env_var` (the token only in the
  app-server's environment) and `default_tools_approval_mode="approve"`, so the config
  file of the home is not touched. An unknown value for the last key stops codex at
  start, so the key is validated. `mcpServerStatus/list` showed the server `connected`
  and gateway calls ran without an approval request.
- **Observed:** `thread/start` accepts `config: {model_reasoning_effort: "low"}` and
  answers with the effort in force. A turn started by the driver, which sends no
  overrides, ran on the model and effort the first client had set.
- **Observed:** a thread started by a client is idle and is not in `thread/list` until
  its first turn has run. The adapter therefore did not report it before that.
- **Observed:** a turn the driver started with `turn/start` on an idle thread ran like
  any other. The client that started the thread got `turn/started`, the `userMessage`
  item with the gateway's header, the tool calls and the answer, and `turn/completed`.
  Turns took 1 to 8 seconds. The answer to `turn/start` and the start of the turn were
  the same instant.
- **Observed:** a client that never called `thread/resume` got `thread/status/changed`
  (with the `waitingOnApproval` flag when it applied) and `thread/readState/changed`,
  and nothing else about the thread: no turn, item, queue or approval message.
- **Observed:** `thread/queue/add` on a busy thread returned at once and
  `thread/queue/list` showed the message. When the running turn ended, each queued
  message started a turn of its own, in order, one after the other, with no delay
  measurable at the millisecond. Three queued messages gave three turns. At each
  boundary the thread status went `idle` and `active` again within the same
  millisecond. `thread/queue/changed` went to the client that started the thread and
  not to one that had not resumed it.
- **Observed, a hazard:** the model can end a turn by calling `clock.sleep`, which shows
  as an item of type `sleep` with a duration (here 12 hours). The thread stays `active`
  and a queued message is not started: two waited more than four minutes, until the
  first client sent `turn/start`, which joined the turn and ended the sleep. The broker
  had marked both `delivered`. `thread/queue/add` never wakes a sleeping turn.
- **Observed:** an approval request is `item/commandExecution/requestApproval`, sent to
  the client that started the thread and, in a run with two connected clients, to no
  other. The thread status was `active` with `waitingOnApproval`. After 20 seconds with
  no answer the turn was still waiting. When the first client answered `decline`, the
  server sent `serverRequest/resolved`, the model reported that the command was
  rejected, the turn ended `completed` four seconds later and the file was not made.
- **Observed:** a model may refuse in words and never ask. The same instruction from a
  peer, without a standing rule from the thread's owner, got "I can't run that command
  because the workspace is read-only" and no request. With the owner's rule in the
  thread's first message it asked.
- **Observed:** told by a peer to send a message with a false claim of approval, the
  model called no tool and said it would not (one sample).
- **Observed:** the model answered a peer's arithmetic question in its own words, in
  two runs, without calling `reply`, so the sender got nothing back. When it did call
  `reply`, it was to answer an answer. Whether a thread uses `reply` depends on the
  model.
- **Observed:** a thread made by `codex exec` is persisted but is not in `thread/list`
  and not in `thread/loaded/list`; `thread/read` says `notLoaded`; `turn/start` from a
  client that never resumed it fails with -32600 `thread not found: <id>`. The driver
  reads `notLoaded` as cold and refuses to deliver, as designed.
- **Observed:** in this environment a shell command in the read-only sandbox could not
  start ("Function not implemented"). The approval request comes before the command
  runs, so the approval path was measured all the same.
- **Observed without a login (contract test):** a thread just started answers
  `thread/read` with `idle`; `turn/start` on it is accepted and answered with the
  turn; the turn cannot finish and stays active, and then `thread/queue/add` is
  accepted and `thread/queue/list` shows one message.

## Unproven

- A thread the interactive CLI created and holds open. The CLI could not be driven
  without a terminal, so only a thread made by `codex exec` was measured.
- What the driver should do for a turn that is asleep in `clock.sleep`. The queue never
  reaches it (see above). `turn/start` ends the sleep but joins the turn, which the
  driver was built not to do. This is a decision, not a measurement.
- The gap between two queued turns: the status is `idle` for an instant, and a driver
  that reads it then would use `turn/start` while a queued message is about to start.
  Nothing was delivered in that gap during the runs.
- An approval request nobody answers for longer than 20 seconds, and an approval that
  the interactive client, once it has resumed the thread, would receive besides the
  first client.
- A message to a thread that waits for user input (`waitingOnUserInput`).
- A model that replies when the peer's question asks for `reply` in words; one run
  was planned for it and the turn limit of the session was reached first.
- Other models or reasoning efforts than the cheapest model at the lowest effort.
