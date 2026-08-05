# Codex owns conversation history; Norvyn keeps no database

Codex already persists every Thread as a rollout JSONL under `~/.codex/sessions/`
and exposes `thread/list` and `thread/resume` over the app-server protocol, so
Norvyn stores no conversation data of its own and ships with no database. History,
Workspace listings, and resumption are all read back out of Codex.

## Considered Options

Owning history in a local SQLite database was the obvious alternative, and it is
what a second Provider will eventually force. It was rejected for the MVP because
writing a schema now means guessing the shape of data we have not yet worked with,
and because a Norvyn-owned store would sit alongside Codex's own rollout files
rather than replacing them — two records of the same conversation, free to drift.
Delegating also means Threads started in Norvyn remain readable from Codex CLI and
the IDE extensions, which a private database would break.

## Consequences

This decision leaks into the abstraction, and deliberately so: `listThreads` and
`resumeThread` are only coherent because the Provider happens to own history.
Rather than let that leak spread, the seam is drawn explicitly — `Transport`
(lifecycle, turns, events, approvals) is a separate interface from `ThreadStore`
(listing and resuming). Codex implements both today. A Provider that stores
nothing, or stores it in a shape we cannot map, gets a Norvyn-owned `ThreadStore`
implementation without any change to its `Transport`.

The cost is accepted for now: cross-Provider history in one list is not possible
while each Provider owns its own store, and reversing this decision means writing
the SQLite store that was deferred — but only behind `ThreadStore`, not through
the transport layer.
