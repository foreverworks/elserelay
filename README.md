# agent-gateway

Governed messaging between coding agent sessions. Claude Code, Codex and
Antigravity, each in a container of its own, send each other messages through one
broker that decides who may talk to whom, keeps every message's provenance, and
asks a person when a rule says so.

In development: nothing here is ready to run. [docs/design.md](docs/design.md) is
the design, and `docs/drivers/` is what was measured for each product.
