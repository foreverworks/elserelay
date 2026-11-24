# Design

Coding agents from different vendors cannot talk to each other, and letting them
do so without rules is worse than not letting them. An agent that reads a hostile
web page could pass its instructions to another one that can spend money. This
gateway carries messages between agent sessions and decides, for every message,
whether it may go, who it came from, and whether a person has to say yes first.

## Shape

```
        agent container A                       agent container B
 ┌───────────────────────────┐           ┌───────────────────────────┐
 │ CLI ──MCP (send, inbox)─┐ │           │ ┌─MCP (send, inbox)── CLI │
 │  ▲                      │ │           │ │                      ▲  │
 │  │ driver               │ │           │ │               driver │  │
 │ adapter ──stream──┐     │ │           │ │    ┌──stream── adapter  │
 └───────────────────┼─────┼─┘           └─┼────┼──────────────────--┘
                     ▼     ▼               ▼    ▼
                  ┌───────────────────────────────┐
                  │ broker: policy, limits, queue,│
                  │ audit log, approver           │
                  └───────────────────────────────┘
```

- **One broker**, in a container of its own. It never connects to an agent.
- **One adapter per agent container**, beside the CLI, never in front of it. It
  dials out to the broker, reports the sessions it sees, and delivers messages
  through a driver. `ELSERELAY_SESSIONS`, a list of session ids separated by commas
  or spaces, is optional: when it is set the adapter reports only those sessions
  and refuses a delivery to any other with `retry: false`, whatever the broker
  asks. Unset means every session; set but empty is an error, so a value lost on
  the way never widens the list. The adapter logs the list it read when it
  starts. The list is the container's own, so it holds when the broker is wrong
  or hostile. It covers the adapter only, not the pull path: a session, or the
  hook, asks the broker's `inbox` for the messages of a session id it names, and
  the broker takes that id on the caller's word, since a session is a claim and
  only the container is verified. A container that must not read another
  session's messages needs a container of its own.
- **One driver per product.** It knows how that product takes a message and
  holds no policy: `list`, `deliver`, `status`, `capabilities`.
- **Agents speak MCP to the broker**: `list_peers`, `send`, `inbox`, `reply`. A
  new product needs a driver and an MCP registration, nothing else.
- **A product that cannot be pushed to** has a hook instead. The hook runs
  `elserelay hook <product>`, which asks the broker for the session's waiting
  messages (`POST /adapter/inbox`, with the container's token, the same service
  call as the MCP `inbox`) and prints them in the product's own format. Once its
  output is written it confirms the messages with a second request to the same
  path, and ignores a failure of that request. A hook never delays or breaks the
  agent: it has three seconds, and any failure prints nothing.

If the gateway stops, agents keep working and only messages wait.

## Identity

A bearer token names a **container**. The broker takes the sender's container
from the token and never from the call, so a container cannot speak for another.
The **session** inside it is a claim: the adapter and the agent run as the same
user, so a compromised container can lie about which of its sessions is speaking.
Policy therefore decides on containers and products, and so does every limit
that has to hold against a lying container: the rate per pair of containers is
the bound it cannot pass by changing the session it claims. A session id is for
addressing and for the reader of the log, and what a session or an adapter
reports as its id or title is cleaned to one line of plain characters before it
is stored; a session id that cleaning would change is left out of the report. The product is bound to the container
by the broker's config, not by what an adapter reports: a token whose label the
config does not list, or a report naming another product than its container's,
is refused with a 403.

An optional PreToolUse hook (`elserelay hook claude` or `hook codex`, in
docs/hooks.md) fills the `session` argument of the gateway's tools with the id
the product itself reports for the calling session. That makes the claim right
by default, so a model cannot mistype it or name another session by accident.
It is not a security boundary: the hook runs as the same user as the agent, and
the session stays a claim.

A sender is told as little as the policy allows. A refusal by policy says that
no rule lets it message that session and never names the rule, which the
operator reads in the audit. A message to a container the broker does not know
is answered in the same words and the same shape, so a sender cannot tell a
container it may not reach from one that does not exist.

## Provenance

A receiver sees a message as data from a named peer. The envelope says the
container, the product, the claimed session, the thread and the hop count, and
that nothing in the message carries the authority of the person the receiver
works for. The gateway cannot make a model obey that line. It can make sure the
line is always there and cannot be forged by the body.

## Policy

A declarative file. Rules are read in order, the first match decides, and no
match is a refusal. A rule matches on the sender's and the receiver's container
and product, and answers `allow`, `deny` or `ask`. `ask` holds the message until
the approver answers; no answer in time is a refusal. The rules are checked again
at delivery, so a rule added while a message waits still applies to it: a `deny`
refuses the message, and an `ask` holds a queued message for the approver, as if
it had just been sent. A message a person has already approved is never asked
about again, whatever the rule says by then.

## Message states

```
            ┌────────► refused ◄───────┬───────────┐
 received ──┤                          │           │
            ├────────► held ───────────┤           │
            │           │ ▲            │           │
            │  approved │ │ the rule   │           │
            │           ▼ │ now asks   │           │
            └────────► queued ─────► delivering    │
                        ▲   │           │  │       │
                        │   │ expired   │  └──► delivered
                        │   └──────► expired
                        └─ retry ───────┘
```

`refused`, `expired` and `delivered` are final. **Delivered means the driver
handed the message over, not that a model read it.** The only receipt is a reply.
Some products acknowledge nothing, so a driver reports how sure it is:
`confirmed` (the product answered), `accepted` (it took the bytes and said
nothing).

A message leaves in one of two ways, and `delivering` covers both.

- **Pushed.** The broker hands it to the container's adapter, which hands it to
  the driver and reports the outcome. A definite failure puts it back in the
  queue and counts as an attempt. A handed-out message whose outcome never
  arrives within the delivery timeout goes back to the queue too, marked as one
  with no outcome, and counts as an attempt; after `maxAttempts` it is refused.
- **Pulled.** The session calls `inbox` (or the hook does). The messages come
  out as `delivering`, marked as pulled, and a pull is not an attempt. They
  become `delivered`, with certainty `confirmed`, when the session passes their
  ids in `received` on its next `inbox` call, or answers them. A pulled message
  nobody confirmed comes back on the next `inbox` call after the delivery
  timeout, with one line before it saying it was given before. After it has
  been returned 3 times (four times handed out in all) the next call settles it
  as `delivered` with certainty `accepted`, so a session that never confirms is
  not given the same message every minute for a day; its expiry ends it
  otherwise. One `inbox` call hands out at most 50 messages, oldest first, and
  the answer says when more may be waiting; the rest come with the next call,
  and a confirmation takes at most 100 ids. Because the order is oldest first,
  overdue unconfirmed messages come before newer ones, so 50 of them can delay
  newer messages until they are confirmed or settled; settling a message does
  not count toward the 50. The push path never retries a pulled message and is not held
  up by one.

`inbox` does not hand out a message whose last push ended with no outcome: the
adapter may have handed it over, so only the push path retries it, with the same
id, and the adapter drops an id it has already handed over. A message whose last
push failed with a definite outcome may be pulled.

Delivery is at least once. A message keeps one id through every retry, and an
adapter drops an id it has already handed over, also after a restart: the ids
are on disk, the file and its directory flushed, before the adapter reports an
outcome. An adapter that dies between handing over and acknowledging can deliver
twice; a message must not be the only guard in front of an action that cannot be
repeated. The Claude driver does not retry a socket that failed after the line
was written (the outcome is unknown, so the message is refused and the sender
is told); it retries a failure before the write.

Writes that the clock decides on (an expiry, a delivery timeout, an approval
that ran out) apply only if the message is still in the state they read, so
they cannot undo an answer given at the same moment, from the command line say.

A refused message keeps no text. Its length and the SHA-256 of its body stay,
and the body is removed whenever a message is refused, whether at once or later.

## Limits

Two agents can answer each other for ever, and waking a large session that went
cold makes it read its whole context again.

- **Hops:** a reply adds one to its thread's count; past the limit it is refused.
  They stop agents that loop by themselves, so they also count through `send`: a
  `send` from a session that was handed a message by the target container within
  the last 10 minutes starts at that message's hop plus one, in a new thread, and
  is refused past the limit like a reply. The 10 minutes count from the first
  time the message was handed to the session (its first hand-out or pull), not
  from a later pull, acknowledgement or settling, so none of those opens a new
  window. A pair that loops through `send` more slowly than that window is not
  counted by hops at all and is bounded by the pair rate alone. The refusal says
  that the session was answering a recent message from that container, that the
  count is not one of its own threads, and how long to wait before a new topic.
  The session is a claim, so an agent in a compromised container can start from
  zero by naming another one; the pair rate below is the bound it cannot pass.
- **Rate:** messages per pair of containers in a sliding window.
- **Refusals:** refused messages per sender container in a sliding window
  (`limits.refusals`, 60 an hour by default). Past it a refusal is not stored at
  all, the sender is told so, and one line per window and container goes to the
  control log beside the audit. The body is cleared before anything is stored
  for a refused message, so a container that only sends refusable messages
  cannot fill the store.
- **Waking:** off by default. A message to a cold session waits in its inbox until
  its next turn. A rule can allow waking for a pair.
- **Stop:** one switch. At send, a message is refused with the reason `stopped`
  (a `deny` rule still answers first, so a stopped gateway tells a sender nothing
  more about what exists). At delivery, nothing leaves: a message queued before
  the stop stays queued, push and `inbox` hand out nothing, and it goes after
  `start`; its expiry keeps running meanwhile. Every stop and start is written to
  a control log beside the audit, which like the audit cannot be changed or
  removed.
- **Offline adapters:** an adapter keeps one stream open to the broker. When a
  container's stream has been closed for more than 90 seconds, its sessions are
  shown as `unknown` with `offline: true` in `list_peers`, and nothing is pushed
  to them, not even where a rule allows waking. A send still queues, and a
  session can still pull its own inbox. The stream opening again lifts it.

Every limit refuses with a reason the sender can read.

## Approver

An interface: it gets a request (who, to whom, the text) and starts asking
someone. The answer does not come back through the interface: whoever answers
calls the service's `approve` or `refuse`, which is also what the command line
does. So the command line and a configured approver can both answer, the first
answer wins, and the message leaves the held state once. A yes that arrives at or after the deadline
is a refusal with the reason `timeout`: the sender may already have been told
that no answer in time is a refusal.

The config picks the approver in `approver`. The command line is always there,
beside whatever else is configured.

- **`cli`**, the default. It logs that a message waits, without its text. A
  person reads it with `elserelay approvals` and answers with `approve` or
  `refuse`.
- **`command`**. The broker runs a program of the operator's for each held
  message and takes its answer. This is how a deployment plugs in a phone
  prompt, a chat bot or a ticket queue without the gateway knowing any of them.

### The command contract

For each message that becomes held the broker starts `argv[0]` with the rest of
`argv` as its arguments. There is no shell: an argument is never expanded or
split. The broker writes one JSON object on the program's standard input, closes
it, and reads its standard output.

```json
{
  "id": "6f1c...",
  "thread": "6f1c...",
  "hop": 0,
  "from": { "container": "alpha", "product": "claude", "session": "a1", "title": "Alpha one" },
  "to": { "container": "beta", "product": "codex", "session": "b1" },
  "body": "the sender's text, exactly as sent",
  "rule": "ask-first",
  "heldAt": 1795000000000,
  "decideBy": 1795000900000
}
```

`rule` is the name of the rule that asked, or null when the default did. The
times are milliseconds since the epoch. `title` is null when the session has
none. The container is the one the sender's token proves, the session and the title
are the sender's claim, and `body` is untrusted: show it
to a person escaped, as `elserelay approvals` does (`escapeForTerminal` in
`src/broker/approver.ts`), never as markup or as something to run.

What a yes delivers is not the body alone: the receiving session is handed the
gateway's own header (the sender's container, product, claimed session title and
id, the thread, the hop and the message id) and then the body in a fence. The
header is built by `render` in `src/core/render.ts` from exactly the fields of
this request, and it never changes after the message is sent (the title is the
one the sender claimed when it sent the message, kept with the message, not read
again from the peer's report). An approver that wants a person to approve what is
delivered should show that text, as `elserelay approvals` does with the
title and the elsewire command does with the whole text.

The program answers with exactly one JSON value on standard output and exit
status 0: `{"answer":"approve"}` or `{"answer":"refuse"}`. A refusal may carry a
reason code, `{"answer":"refuse","reason":"too-long"}`, so that the sender is told
the true reason instead of the words for a person's no. The only code there is
is `too-long` (the message is more than a person can be asked to read, which
the sender reads as "too long for a person to approve"); a `reason` with any other
value, or on an approve, makes the whole output no answer. Everything else is
**no answer**: a non-zero status, no output, output that is not that object,
more than 64 KiB of output, a program that cannot start. No answer is never
taken as a yes. The broker logs that there was none (the reason in a few words,
never the message text and never what the program printed to standard output)
and the message stays held, so the command line can still answer it and the
deadline still refuses it. While the message is held the broker runs the program
again after 30 seconds, then 60, doubling up to 5 minutes between runs.

What the program prints to standard error goes into the broker's log, one line
at a time, cleaned of control characters and cut at 500 characters. It must not
print the message there.

The broker starts the program as the leader of a process group of its own and
ends it with a signal to that group while the program itself is still running
(never to a group whose leader has already ended), with SIGKILL after 5
seconds if it is still there. The signal says why:

- **SIGTERM, the question is moot**: the message's `decideBy` was reached, or the
  message stopped being held (a person answered from the command line, or it was
  refused or expired). A program that has put a question in front of a person
  should withdraw it.
- **SIGINT, the broker is closing**: the message is still held and the next
  broker will run the program again, so a program should leave its question as it
  is and exit.

The broker does not wait for the program's output pipes to close: once the
program has ended it reads what arrived in the next second, closes the pipes and
moves on, so a helper the program left running with the pipe open cannot hold a
place or the shutdown. A helper left behind after the
program ended is not signalled: its group's leader is gone, and the group's id may
mean something else by then.

The broker does not wait for a program that is no longer asked. An answer that
comes after any of these is dropped, and one that reaches the service late is
refused there as before. A real answer is not dropped for a busy database: when
the write fails and the message is still held, the broker writes the same answer
again after 250 ms, 500 ms, 1 s and 2 s, and only then counts it as no answer
(and runs the program again as above). At most 16 programs run at once; the other messages
wait for a free place in the order they were held.

The program's environment is `PATH`, `HOME` and `LANG` of the broker's own, the
variables named in the config's `passEnv`, and `ELSERELAY_APPROVER_STATE_DIR`
when the config sets `stateDir`. Nothing else of the broker's environment
reaches it, so a secret the broker holds stays with the broker. The program
runs in the broker's working directory.

**A command must be idempotent by `id`.** The broker keeps its questions in
memory. After a restart a message that is still held is asked about again, and
the program is run again with the same `id`, even if an earlier run had already
put a question in front of a person. A message that leaves the held state and
comes back (a queued message whose rule now says `ask`) is also run again, with
the same `id` and a new `decideBy`. So the program keeps what it needs, in its
state directory, to find its earlier question by `id` and ask nothing twice. The
ready-made command below does that.

### Asking through Elsewire

`elserelay approver elsewire` is a command for the contract above. It asks
a person through an Elsewire server, an MCP server over streamable HTTP with
bearer authentication, and needs `ELSEWIRE_URL`, `ELSEWIRE_TOKEN_FILE` and
`ELSEWIRE_STATE_DIR`.

It creates one request with the `review` connector. The person is shown the
text the receiving session will be handed, built by the gateway's own `render`
from the request (so the sender's claimed session title is in it, in the header,
above the fence that holds the body), with every control character escaped and
the whole of it inside a code fence longer than any run of backticks in it, so no
formatting can hide a part of it. The request has two quick replies, "Refuse" and "Not now" (Elsewire
requires two to four), both of which end it denied, a refusal, and
allows no note (`notes: false`), so a person cannot write "don't send" and still
send. The person approves by sending the draft back as it is. A yes counts only
when the returned text is the draft, unedited and without a note: the gateway
never rewrites a sender's words, so an edited text, or an answer that carries a
note anyway, is a refusal.

Elsewire limits a draft to 4000 characters, so a text that is longer once
escaped is refused without asking, with the reason `too-long`: the sender is told
the message is too long for a person to approve. The header takes about 900
characters (up to about 1200 with the longest names), so with this approver keep
`policy.limits.maxBodyChars` under about 2800, or messages near the limit are
refused for length after a person was never asked.

The id of the Elsewire request is written to a file named after the SHA-256 of
the message id before the program waits, so a second run for the same message
waits for the same request. The file is removed after a final answer. Before it
asks, the program checks that its state directory can be written to (it creates
it, and makes it private to its owner when it is ours), and asks nothing if not;
if the file cannot be written after the request was made, the request is
cancelled and there is no answer. At each start it removes state files older than
7 days and temporary files older than an hour.

On SIGTERM (the question is moot) it cancels the request with `elsewire_cancel`
and removes its file, so no question is left open on a person's phone for a
message that no longer waits. On SIGINT (the broker is closing) it leaves both as
they are, and the next broker run waits for the same request. A failed request or
an unreachable server is no answer (exit status 1), and the broker tries again.

## What this does not do

- Model calls do not pass through it.
- It does not start agents or give them work.
- It does not protect against an attacker with a shell in a container: they hold
  that container's token. It limits what that token can reach, and it records it.

## Build

TypeScript, functions and explicit state, effects at the edge. Node's own SQLite.
MCP through `@foreverworks/mcp-kit`, whose per-client tokens are the containers'
tokens.

```
src/
  core/      pure: message, states, policy, limits, render
  store/     SQLite: messages, peers, audit
  broker/    the MCP tools, the adapter channel, the approvers (command line, command)
  approver/  ready-made commands for the command approver
  adapter/   the loop that runs beside an agent
  hook/      the commands a product's hook runs
  drivers/   fake, claude, codex, antigravity
```
