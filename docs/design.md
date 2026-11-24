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
  through a driver.
- **One driver per product.** It knows how that product takes a message and
  holds no policy: `list`, `deliver`, `status`, `capabilities`.
- **Agents speak MCP to the broker**: `list_peers`, `send`, `inbox`, `reply`. A
  new product needs a driver and an MCP registration, nothing else.
- **A product that cannot be pushed to** has a hook instead. The hook runs
  `agent-gateway hook <product>`, which asks the broker for the session's waiting
  messages (`POST /adapter/inbox`, with the container's token, the same service
  call as the MCP `inbox`) and prints them in the product's own format. A hook
  never delays or breaks the agent: it has three seconds, and any failure prints
  nothing.

If the gateway stops, agents keep working and only messages wait.

## Identity

A bearer token names a **container**. The broker takes the sender's container
from the token and never from the call, so a container cannot speak for another.
The **session** inside it is a claim: the adapter and the agent run as the same
user, so a compromised container can lie about which of its sessions is speaking.
Policy therefore decides on containers and products. A session id is for
addressing and for the reader of the log. The product is bound to the container
by the broker's config, not by what an adapter reports: a token whose label the
config does not list, or a report naming another product than its container's,
is refused with a 403.

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

Delivery is at least once. A message keeps one id through every retry, and an
adapter drops an id it has already handed over. An adapter that dies between
handing over and acknowledging can deliver twice; a message must not be the only
guard in front of an action that cannot be repeated.

## Limits

Two agents can answer each other for ever, and waking a large session that went
cold makes it read its whole context again.

- **Hops:** a reply adds one to its thread's count; past the limit it is refused.
- **Rate:** messages per pair of containers in a sliding window.
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
own.

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
