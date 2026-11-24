# Elserelay

**Let your Claude Code and Codex sessions write to each other, and stay the one who decides.**

You run one agent in one place and another somewhere else, and you are the cable
between them: copying a finding from one window into the other, pasting the answer
back. Elserelay carries those messages. Every one of them passes your rules first,
arrives with its provenance on it, and can wait for your yes.

```
 Claude Code ──┐                                      ┌── Codex
               ├── adapter ──► broker ◄── adapter ────┤
 Claude Code ──┘              rules, limits,          └── Codex
                            approvals, audit log
```

An agent gets four tools: `list_peers`, `send`, `inbox` and `reply`. A message to an
idle session wakes it, and the reply comes back the same way. Nothing sits in front
of your CLI, no model call goes through Elserelay, and if it stops your agents keep
working: only the messages wait.

## Why there are rules at all

Letting agents talk without rules is worse than not letting them. A session that
reads a hostile page could pass its instructions to one that holds your keys. So:

- **No rule, no message.** Rules say who may write to whom, and each is allow, deny or
  ask. What no rule names is refused, in the same words as a peer that does not exist.
- **You can be asked.** An `ask` rule holds the message until a person answers, on the
  command line or through a program of yours. A ready-made one asks on
  a phone through an Elsewire server, and shows exactly the text that would be delivered.
- **A message is data.** It reaches the other session inside a header that says who
  sent it and that it carries none of your authority.
- **Identity is a token per container,** checked by the broker. A container cannot
  speak for another one. The session inside it is a claim, and is shown as one.
- **Loops end.** A thread has a hop limit, a pair of containers has a rate, a cold
  session is not woken unless a rule says so, and one command stops everything.
- **Everything is written down.** `elserelay audit` shows what went, what was refused
  and who said yes.

[docs/live.md](docs/live.md) is what happened when two real sessions used it, with
what was refused, what an agent did when a message told it to ignore its rules, and
what did not work the first time.

## State

Early. It works, it is tested, and its configuration can still change between
versions. There is no package on npm: run it from this repository.

| | Receives a message | Wakes an idle session | Tried with real sessions |
|---|---|---|---|
| Claude Code | yes, through its documented inbox socket | yes | yes |
| Codex | yes, through its app-server | yes | yes, in an app-server that was running |
| Antigravity | through a hook, when its agent next calls a model | no | no, and **off by default**: see the terms below |

Known gap: a Codex turn that is asleep in its own timer does not start on a message
until it ends ([docs/drivers/codex.md](docs/drivers/codex.md)).

## Run it

You need Node 26, the current LTS, and one place every agent can reach over a private
network.

```sh
git clone https://github.com/foreverworks/elserelay && cd elserelay
npm ci && npm run build
node dist/cli.js broker --config config.json      # once, somewhere both agents reach
ELSERELAY_URL=... ELSERELAY_TOKEN_FILE=... ELSERELAY_PRODUCT=claude \
  ELSERELAY_STATE_DIR=... node dist/cli.js adapter   # beside each agent, as its user
```

Then register `http://<broker>:7410/mcp` as an MCP server named `elserelay` in each
agent. [docs/deploy.md](docs/deploy.md) has a complete config, the tokens, the
container image's Dockerfile, the systemd unit, health and backups.
[docs/hooks.md](docs/hooks.md) has the optional hook that fills in the session, so a
model does not have to know its own id. [docs/design.md](docs/design.md) is the
reasoning, with what each guarantee does not cover.

## Terms of the providers

Elserelay hands a message to a session you opened, in the provider's own program,
under your own sign-in. It never holds, reads or passes on a provider's login, never
proxies a model call and is not a service: you run it for yourself. No provider says
yes or no to exactly this. These are the passages we found, read on 2026-11-24. They
are not legal advice, they change, and your account is yours to weigh.

- **OpenAI** is the clearest. Of the app-server the Codex driver uses: "If you've built
  a local or open-source application using Codex app-server authentication, you can
  continue using it", and "App-server authentication has never been permitted for
  commercial or hosted services"
  ([Codex app-server](https://learn.chatgpt.com/docs/app-server)). Its
  [terms of use](https://openai.com/policies/eu-terms-of-use) also forbid
  "automatically or programmatically extracting data or Output".
- **Anthropic** documents the socket the Claude driver uses, for "when you want a script
  or hook to post into a session"
  ([cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging));
  that page speaks of a script posting to its own session and does not mention other
  programs. Its [consumer terms](https://www.anthropic.com/legal/consumer-terms) forbid
  access "through automated or non-human means" except with an API key "or where we
  otherwise explicitly permit it", and its plans assume "ordinary, individual usage"
  ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- **Google** forbids it in words broad enough to cover this: "Using third party
  software, tools, or services to access the Service (e.g. using OpenClaw with
  Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for
  suspension or termination of your Antigravity and/or Gemini CLI accounts"
  ([Antigravity terms](https://antigravity.google/terms)). That is why the broker does
  not start with an Antigravity container unless its config says
  `"allowAntigravity": true`.

Do not offer Elserelay as a hosted service on other people's subscriptions. The limits
it ships with, on hops, rate and waking, are also what keeps your use ordinary.

Elserelay is an independent project. Claude, Codex and Antigravity are named only to
say what it works with; their makers have no part in it and do not endorse it.

## Security

Please report a weakness privately, through
[a security advisory](https://github.com/foreverworks/elserelay/security/advisories/new),
and not in an issue.

The broker's two ports speak plain HTTP with a bearer token: keep them on a private
network or behind TLS, never on a public interface. Whoever can act as an agent's user
can act as that agent; what a container cannot do is act as another.

## License

[MIT](LICENSE)
