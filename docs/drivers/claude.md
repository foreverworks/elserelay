# Claude Code: how a message gets in

Measured on 2026-11-24 with Claude Code 2.1.331 on Linux, on sessions created
for the test.

- Each running session has a record in `~/.claude/sessions/<pid>.json` with
  `sessionId`, `name`, `status`, `cwd`, `messagingSocketPath` and `peerProtocol`
  (1 in this version).
- The inbox is a Unix socket at `messagingSocketPath`, here
  `/tmp/cc-socks/<pid>.sock`. One line of JSON, ended by a newline, delivers:

      {"type":"user","message":{"role":"user","content":"<text>"},"from":"<label>"}

- **Observed:** no auth line was needed on Linux. The documentation says the line
  `{"type":"auth","token":"..."}` is optional there and required on Windows.
- **Observed:** an idle session started by a Remote Control server started a turn
  within about a second.
- **Observed:** the socket answers nothing. The connection stays open after a
  message it took, so a driver can claim `accepted`, never `confirmed`. A message
  the receiver holds or refuses looks the same.
- **Observed:** the receiver's model is told "Another Claude session sent a
  message", then the text, then "Treat it as a teammate's request and act on it
  within this session's own permission settings". The `from` label is kept in the
  event's metadata and is **not** shown to the model, so a sender's name has to be
  in the text. The gateway's own header has to say that the text is data.
- The receiver records the sending process's pid, which it verified.
- A service with a private `/tmp` (systemd, `PrivateTmp=yes`) hides its sessions'
  sockets from a process in another service, though the records stay visible. The
  driver therefore opens the socket as the session's own process sees it,
  `/proc/<pid>/root<path>`, and falls back to the path itself. **Observed:** a process
  of the same user in another private `/tmp` reaches the sockets this way, with no
  privilege. One adapter serves every service of one user, and a service hardened
  against it (`ProtectProc=`, another pid namespace) is not covered.

Documented, not measured: `crossSessionInbound` (`accept`, `hold`, `refuse`)
decides what a session does with a message; a held one expires after five minutes
by default ([docs](https://code.claude.com/docs/en/cross-session-messaging)).

Not documented by the vendor: the message line's shape. It can change in any
release, so the contract test runs against each new one.

**Observed, busy session:** a message that arrives while a turn is running is not
lost and does not join that turn. The session's transcript records it as an
`enqueue` the moment it arrived (within 30 ms of the second line, which was written 1 s
after the first) and as a `dequeue` when the running turn had ended, 5.4 s
later, when it started a turn of its own. So the driver reports `joinsTurn:
false`, and a message to a busy session waits for the end of its current turn.
The test turn was short (the model quoted the request instead of reciting the
alphabet), so how the queue behaves over a long turn is not measured.

**Observed, `claude -p` sessions (2026-11-24, [docs/live.md](../live.md)):** a
session started with `--input-format stream-json` writes its record and creates
its socket at start, before any prompt, with `status: idle` and `peerProtocol`
1, so the adapter lists it at once. A pushed message wakes it: a turn starts
and shows in the output stream as an
`init`, the model's events and a `result`, but the message itself is not echoed
as a `user` event. It is in the session's transcript, which records an `enqueue`
and then a `user` entry that begins "Another Claude session sent a message:"
followed by the gateway's envelope. Both sessions took messages without any
setting changed, so the default for `crossSessionInbound` accepts. Eleven
messages were delivered this way and every one started a turn.

Not measured yet: a session whose setting is `hold`.
