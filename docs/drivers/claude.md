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
- The session's file system has to be shared: a service with a private `/tmp`
  hides its sessions' sockets from a process in another service, though the
  records stay visible. The adapter has to run in the same mount namespace
  (systemd: `JoinsNamespaceOf=`).

Documented, not measured: `crossSessionInbound` (`accept`, `hold`, `refuse`)
decides what a session does with a message; a held one expires after five minutes
by default ([docs](https://code.claude.com/docs/en/cross-session-messaging)).

Not documented by the vendor: the message line's shape. It can change in any
release, so the contract test runs against each new one.

Not measured yet: a busy session, and a session whose setting is `hold`.
