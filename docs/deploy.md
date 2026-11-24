# Deploying

One broker runs somewhere every agent container can reach. Beside each agent
runs one adapter. This page says how to configure and run both, and how to keep
the broker's data. [design.md](design.md) says what they do.

## The broker in a container

The `Dockerfile` at the repository root builds one image that runs every command
(`broker`, `adapter`, `approver elsewire`, `health` and the admin commands). It
is based on `node:26-slim`, pinned by digest, and runs as user 10001, so it works
with a read-only root file system and one writable volume, `/data`.

```sh
docker build -t agent-gateway .
docker run -d --name gateway --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  -v gateway-data:/data \
  -p 127.0.0.1:7410:7410 -p 127.0.0.1:7411:7411 \
  agent-gateway
```

The image expects `/data/config.json` (the `AGENT_GATEWAY_CONFIG` variable
points there) and, if the config says so, the tokens and the SQLite file under
`/data` too. The volume must be writable by user 10001. The admin commands run
in the same image, so a person answers a held message with
`docker exec gateway node /app/dist/cli.js approve <id>`.

The image's healthcheck runs `agent-gateway health`, which asks
`http://127.0.0.1:7411/healthz`. If the config uses another adapter port, set
`AGENT_GATEWAY_HEALTH_URL` on the container to match.

Without a container: `npm ci && npm run build`, then
`node dist/cli.js broker --config /etc/agent-gateway/config.json`. Node 26 or
later is required.

## Health

`GET /healthz` on the adapter port answers `200` and the word `ok` to anyone,
with no token, and says nothing else: no version, no counts. It only shows that
the process is up and the port is open. `agent-gateway health <url>` asks it and
exits 0 on a 200 and 1 on anything else, for a healthcheck on a machine without
curl. With no argument it reads `AGENT_GATEWAY_HEALTH_URL`.

## Configuration

A JSON file, named by `--config` or by `AGENT_GATEWAY_CONFIG`. An unknown key is
an error, and an error message lists the problems without quoting the file.

| Key | Meaning | Default |
|---|---|---|
| `store` | Path of the SQLite file. | required |
| `tokensDir` | Directory of `token-<container>` files, see below. | required |
| `listen.host` | Address both ports bind to. | `127.0.0.1` |
| `listen.mcpPort` | Port of the MCP door the agents' CLIs call (`/mcp`). 0 picks a free one. | required |
| `listen.adapterPort` | Port of the adapters' door (and `/healthz`). 0 picks a free one. | required |
| `listen.allowedHosts` | Host names the MCP door answers besides the loopback ones. Needed when `listen.host` is not a loopback address. | `[]` |
| `containers` | The containers that may connect: a map from token label to `{ "product": "claude" \| "codex" \| "antigravity" \| "fake" }`. The product is bound to the label here, not by what an adapter says. | required |
| `deliveryTimeoutMs` | How long a handed-out message may wait for its outcome before it goes back to the queue. | `60000` |
| `pollMs` | How often the broker expires, retries, asks for approvals and pushes what waits. | `1000` |
| `approver` | Who is asked about a held message, besides the command line: `{ "kind": "cli" }` or `{ "kind": "command", ... }`, see below. | `{ "kind": "cli" }` |
| `policy.rules` | Rules in order, the first match decides, no match is a refusal. Each is `{ name, from, to, decision, wake? }`. `from` and `to` match on `container` and `product`, both optional. `decision` is `allow`, `deny` or `ask`. `wake: true` lets a message wake a cold session. A rule may only name containers that are in `containers`. | `[]` |
| `policy.limits.maxHops` | Replies in a thread before a message is refused. | `6` |
| `policy.limits.rate` | `{ messages, windowMs }`: messages per pair of containers in a sliding window. | `20` per `3600000` |
| `policy.limits.maxBodyChars` | The longest body, in characters. | `16000` |
| `policy.limits.messageTtlMs` | How long a message may wait before it expires. | `86400000` |
| `policy.limits.approvalTtlMs` | How long a held message waits for an answer before it is refused. | `900000` |
| `policy.limits.maxAttempts` | Pushed deliveries before a message is refused. | `5` |
| `policy.limits.refusals` | `{ messages, windowMs }`: refused messages kept per sender container in a window. | `60` per `3600000` |

The `approver` section, when it is a command:

| Key | Meaning | Default |
|---|---|---|
| `argv` | The program and its arguments, at least one. Started directly, never through a shell. | required |
| `stateDir` | A directory the command may keep state in. The broker only passes its path, as `AGENT_GATEWAY_APPROVER_STATE_DIR`; the command creates and uses it. | none |
| `passEnv` | Names of variables of the broker's own environment that the command may see. The command also gets `PATH`, `HOME` and `LANG`, and nothing else. | `[]` |

A complete example for a broker in a container, with two agent containers and
one that only reads:

```json
{
  "store": "/data/broker.sqlite",
  "tokensDir": "/data/tokens",
  "listen": {
    "host": "0.0.0.0",
    "mcpPort": 7410,
    "adapterPort": 7411,
    "allowedHosts": ["gateway.internal.example"]
  },
  "containers": {
    "build-box": { "product": "claude" },
    "review-box": { "product": "codex" },
    "notes-box": { "product": "antigravity" }
  },
  "deliveryTimeoutMs": 60000,
  "pollMs": 1000,
  "approver": {
    "kind": "command",
    "argv": ["node", "/app/dist/cli.js", "approver", "elsewire"],
    "stateDir": "/data/approver",
    "passEnv": ["ELSEWIRE_URL", "ELSEWIRE_TOKEN_FILE"]
  },
  "policy": {
    "rules": [
      { "name": "build-to-review", "from": { "container": "build-box" }, "to": { "container": "review-box" }, "decision": "allow", "wake": true },
      { "name": "review-to-build", "from": { "container": "review-box" }, "to": { "container": "build-box" }, "decision": "allow" },
      { "name": "anything-to-notes", "from": {}, "to": { "container": "notes-box" }, "decision": "ask" }
    ],
    "limits": { "maxHops": 6, "rate": { "messages": 20, "windowMs": 3600000 }, "approvalTtlMs": 900000 }
  }
}
```

With this file a message from `notes-box` to anyone is refused, because no rule
lets it. `ELSEWIRE_STATE_DIR` is not set, so the Elsewire command takes the
directory from `stateDir`.

## Tokens

A token names a container. Put one file per container in `tokensDir`, named
`token-<container>` after its label in `containers`, holding only the token, at
least 16 characters, with nothing else in the file. Make each one random and
different:

```sh
umask 077
openssl rand -hex 32 > tokens/token-build-box
```

The broker reads the directory when it starts, so a new or changed token needs a
restart. A token whose label is not in `containers` is accepted and then refused
everywhere, and the broker says so in its log. The same file is what that
container's adapter and its agent's MCP client present, as a bearer token. In a
container's own deployment, mount only that container's file. The broker never
logs a token.

An agent's CLI registers the MCP door at `http://<broker>:7410/mcp` with
`Authorization: Bearer <token>`.

## The adapter

One adapter runs beside the agent it serves and dials out to the broker's
adapter port. Its settings come from the environment:

| Variable | Meaning |
|---|---|
| `GATEWAY_URL` | The broker's adapter address, such as `http://gateway.internal.example:7411`. |
| `GATEWAY_TOKEN_FILE` | A file holding this container's token. |
| `GATEWAY_PRODUCT` | `claude`, `codex`, `antigravity`, or `fake` for a try-out. Must match the product the broker's config binds to this token's label. |
| `GATEWAY_STATE_DIR` | Where the adapter keeps the ids it has delivered. Must survive a restart. |
| `GATEWAY_SESSIONS` | Optional. Session ids separated by commas or spaces: the only sessions this adapter reports and delivers to. Unset means every session; set but empty is an error. |
| `CODEX_SOCKET`, `CODEX_HOME` | Codex only: the app-server's control socket, or the folder it is under (default `~/.codex`). |
| `ANTIGRAVITY_SUMMARIES_DB` | Antigravity only: the CLI's `conversation_summaries.db`. |

An adapter must run as the same user as the sessions it serves, because it
reaches them through that user's files and sockets.

### Claude Code under systemd

Claude Code opens each session's inbox as a Unix socket under `/tmp`
(`/tmp/cc-socks/<pid>.sock`). A service with `PrivateTmp=yes` has its own empty
`/tmp`, so an adapter in another service cannot see the sockets of the service
that runs the sessions. Either run the adapter in the same service as the
sessions, or make its unit join that service's mount namespace with
`JoinsNamespaceOf=`. That setting only works when both units have
`PrivateTmp=yes`.

```ini
# /etc/systemd/system/agent-gateway-adapter.service
[Unit]
Description=agent-gateway adapter for Claude Code
After=network-online.target
Wants=network-online.target
# Share the private /tmp of the service that runs the Claude Code sessions.
JoinsNamespaceOf=claude-sessions.service

[Service]
User=agent
PrivateTmp=yes
LoadCredential=token:/etc/agent-gateway/token-build-box
StateDirectory=agent-gateway-adapter
Environment=GATEWAY_URL=http://gateway.internal.example:7411
Environment=GATEWAY_PRODUCT=claude
Environment=GATEWAY_TOKEN_FILE=%d/token
Environment=GATEWAY_STATE_DIR=%S/agent-gateway-adapter
ExecStart=/usr/bin/node /opt/agent-gateway/dist/cli.js adapter
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`claude-sessions.service` stands for whatever unit runs your sessions, and it
must set `PrivateTmp=yes` too. If your sessions do not use a private `/tmp`,
remove both lines. The adapter logs `connected` when its stream to the broker
is open and `serving` with the sessions it reads when it starts.

## The approver

With the default, `cli`, a held message waits for
`agent-gateway approvals`, then `approve <id>` or `refuse <id>`, and is refused
when `policy.limits.approvalTtlMs` runs out. The command approver adds a program
that answers for you; the command line keeps working beside it. The contract is
in [design.md](design.md#the-command-contract).

To ask a person through an Elsewire server, use the ready-made command, as in the
example above. Its settings are environment variables:

| Variable | Meaning |
|---|---|
| `ELSEWIRE_URL` | The server's MCP address. It must be `https`; plain `http` is accepted only for a loopback address, so a token never crosses a network in the clear. |
| `ELSEWIRE_ALLOW_HTTP` | Set to `1` to accept plain `http` to any address. Only for a network that encrypts on its own, such as a WireGuard mesh. |
| `ELSEWIRE_TOKEN_FILE` | A file holding the bearer token. |
| `ELSEWIRE_STATE_DIR` | Where it keeps the id of the request it opened for each message. Falls back to the `stateDir` of the config. |

List the ones you set in `passEnv` and set them on the broker's container. A
command must be idempotent by message id, because after a broker restart the
program runs again for every message that is still held; the Elsewire command is.

The message is shown inside a code fence, so no formatting in it can hide a part of
it from the person who decides, and the request says it comes from `agent-gateway`,
with the message's thread as its session.

## Backing up the SQLite file

The store runs in WAL mode, so at any moment the committed data may be in the
file `broker.sqlite-wal` beside the main file. Copying only `broker.sqlite` with
`cp` while the broker runs can miss recent writes or give a file that does not
open. Use one of these instead, both safe while the broker runs.

With the `sqlite3` tool:

```sh
sqlite3 /data/broker.sqlite ".backup '/backup/broker-$(date +%F).sqlite'"
```

Without it, from the broker's own image, which has Node 26 and its SQLite
(`VACUUM INTO` writes a consistent copy and refuses to overwrite a file that
exists):

```sh
docker exec gateway node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout = 5000");
db.prepare("VACUUM INTO ?").run(process.argv[2]);
' /data/broker.sqlite /data/backup.sqlite
```

Then copy `backup.sqlite` out of the volume. If you stop the broker first, copying
`broker.sqlite` together with `broker.sqlite-wal` and `broker.sqlite-shm` (all
three, or none) also gives a good copy. A backup holds message text, so treat it as
sensitive.
