# Filling in the session id with a hook

Every gateway tool that acts for a session (`send`, `inbox`, `reply`) takes a
`session` argument, and the model fills it in. A model can mistype it, or name
another session by accident. The `elserelay hook` commands for Claude Code
and Codex fix that: they run before each of those tool calls, read the session
id the product reports for the calling session, and put it into the arguments.

This makes the claim right by default. It is not a security boundary: the hook
runs as the same user as the agent and a compromised container can still lie
about its session. Who is speaking is still known from the token, as described
in the Identity section of `design.md`.

## What the hook does

The hook reads the PreToolUse JSON the product writes on standard input. For
the tools `send`, `inbox` and `reply` of the gateway's MCP server it prints the
same arguments with `session` set to the `session_id` of that JSON, and nothing
else. `title` is left as the model wrote it. `list_peers` takes no `session`,
so it is not touched.

Which tools are the gateway's is decided from the tool name itself, which the
products give as `mcp__<server>__<tool>`. The server name is `elserelay` unless
the environment variable `ELSERELAY_HOOK_SERVER` says otherwise; set it to the
name you registered the gateway's MCP server under. A tool of any other server,
even one that is also called `send`, gets no output at all.

The hook never fails a call and never waits for the network. When standard
input is empty, is not JSON, has no usable `session_id` (missing, empty, or
longer than 200 characters), or the tool is not the gateway's, it prints
nothing and exits 0, and the call goes ahead with whatever session the model
claimed. It needs no settings of the broker, no token and no network.

## Claude Code

Add this to `~/.claude/settings.json`, or to a project's `.claude/settings.json`.
The matcher is a regular expression over the tool name; `mcp__elserelay__.*`
covers every tool of a server called `elserelay` and the hook itself narrows that
to the three tools.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__elserelay__.*",
        "hooks": [
          {
            "type": "command",
            "command": "elserelay hook claude",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The hook does not set a `permissionDecision`, so Claude Code decides whether to
ask, as it would for the call without the hook. Pages read for this section:
`code.claude.com/docs/en/hooks` (the input fields, the `hookSpecificOutput`
shape with `updatedInput`, the MCP matcher syntax and the `timeout` field, in
seconds).

Two things to know. First, the page says that when a hook returns
`updatedInput` without a `permissionDecision` in auto mode, Claude Code can
deny the changed call because the input changed after auto mode reviewed it. If
you run in auto mode and see that, the gateway tools need an allow rule in the
permission settings, or the session should pass `session` itself. Second, tool
calls made by a subagent carry the parent's `session_id` (with an extra
`agent_id`), so a subagent speaks for the session that started it.

### Which id Claude Code reports

The hook's `session_id` and the id the gateway's Claude driver reports are the
same value in the normal case. The driver reads the `sessionId` field of the
running session's record in `~/.claude/sessions/<pid>.json` and uses it as the
session (`src/drivers/claude.ts`, `seen`), and the hook receives the session's
own `session_id`. On a box where this was checked, the record's `sessionId`
equals the `CLAUDE_CODE_SESSION_ID` the process runs with.

The Claude Code documentation does not say what `session_id` is after a
resume or a fork. If a session changes its id while the process keeps running
and its record keeps the old one (or the other way round), the hook claims an
id the driver does not list: messages to it are then not pushed (the driver
finds no running session under that id), and the session reads them with
`inbox`. Nothing is sent to another session by this, and a model that passes
the id itself is in the same position. Check it once on your Claude Code
version by resuming a session and comparing the two values.

## Codex

Add this to `~/.codex/hooks.json`, or to `.codex/hooks.json` of a trusted
project. The same hook can be written under `[hooks]` in `config.toml`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^mcp__elserelay__(send|inbox|reply)$",
        "hooks": [
          {
            "type": "command",
            "command": "elserelay hook codex",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Codex applies `updatedInput` only together with `permissionDecision: "allow"`,
and reports any other combination as an error. So for Codex the hook prints an
allow, and that is why it checks the tool name itself and prints nothing for a
tool that is not one of the three: an allow for another tool would skip its
approval. The allow also means these three calls run without Codex's own
approval prompt; the broker's policy, not the prompt, decides what a message
may do. Codex asks you to review and trust a new or changed hook (`/hooks` in
the CLI) before it runs. Pages read for this section: `learn.chatgpt.com/docs/hooks`
(file locations, the matcher, `session_id`, the `updatedInput` rule, `timeout`).

The page calls `session_id` the current Codex session id, and says subagent
hooks use the parent's. The Codex driver reports each thread's `id` as the
session (`src/drivers/codex.ts`, `seen`). The page does not say outright that
the two are the same value, so confirm it on your Codex version before you rely
on it: run `elserelay hook codex` by hand with a payload copied from a real
call and compare its `session_id` with what `list_peers` shows for that
session. If they differ, the claim is an id the driver does not know, and the
effect is the one described above for Claude Code.
