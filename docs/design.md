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
  through a driver. `GATEWAY_SESSIONS`, a list of session ids separated by commas
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
  `agent-gateway hook <product>`, which asks the broker for the session's waiting
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

An optional PreToolUse hook (`agent-gateway hook claude` or `hook codex`, in
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

An interface: it gets a request (who, to whom, the text) and answers yes, no or
nothing yet. The default is a command-line approver. Deployments plug in their
own. A yes that arrives at or after the deadline is a refusal with the reason
`timeout`: the sender may already have been told that no answer in time is a
refusal.

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
  broker/    the MCP tools, the adapter channel, the approver interface
  adapter/   the loop that runs beside an agent
  hook/      the commands a product's hook runs
  drivers/   fake, claude, codex, antigravity
```
