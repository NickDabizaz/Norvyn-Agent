# The Claude Code CLI is the Claude Transport, and it forces the Norvyn-owned ThreadStore

Norvyn reaches Anthropic by borrowing the Local Session that `claude auth login` leaves behind, spoken to
through the Claude Code CLI running headless:
`claude --print --input-format stream-json --output-format stream-json --verbose`. That is a newline-delimited
JSON event stream over stdio, not an app-server exposing JSON-RPC, so the Claude Adapter does not reuse
`CodexAdapter`'s request/response machinery. Three differences drive its shape:

- **No correlation identifiers.** Codex answers `initialize`, `thread/start`, and `turn/start` by id. Claude
  emits a flat sequence of `system`, `assistant`, `user`, and `result` events with no request to correlate
  them to, so the Adapter tracks Turn state itself rather than resolving pending promises.
- **One process per Thread.** A single Codex app-server multiplexes every Thread. A `claude` invocation is
  bound to one session and one Workspace for its lifetime, so the Adapter owns a pool of child processes keyed
  by Thread, and a Thread's Workspace is fixed the moment its process starts.
- **Norvyn names the Thread.** `--session-id <uuid>` lets Norvyn choose the identifier before the process
  starts, and `--resume <uuid>` reattaches to it later. Thread identity is therefore something Norvyn assigns
  rather than something it reads back, which is what makes the store below possible without inventing a second
  namespace.

Access Mode maps onto `--permission-mode` (`manual` → `manual`, `auto-edit` → `acceptEdits`, `auto` →
`bypassPermissions`), though nothing carries a Chat's Access Mode to the Transport yet — see Consequences. The
Boundary fares worse: the writable half is only approximated, by launching the process with the Workspace as
its working directory and passing no `--add-dir`, and Claude Code has no network-access switch equivalent to
Codex's `sandbox_workspace_write.network_access` at all. Both are recorded below as gaps rather than papered
over, and `resumeThread` reports the weaker guarantees it can actually keep rather than Codex's.

## Claude is the Provider that forces a Norvyn-owned ThreadStore

[ADR-0001](0001-codex-owns-conversation-history.md) deferred a Norvyn-owned store and named the second
Provider as the change that would force it. It does. Claude Code persists each session as a JSONL rollout
under `~/.claude/projects/<escaped-workspace>/<session-id>.jsonl` — the transcript is Provider-owned, exactly
as with Codex — but it exposes no protocol operation to list, search, rename, pin, archive, restore, or fork
those sessions. There is nothing behind `listThreads`, `renameThread`, or `pinThread` to delegate to.

So Norvyn keeps its own index: one record per Thread holding the identifier it assigned, the Workspace, the
display name, pinned and archived flags, and timestamps. It does **not** hold Turns. Transcripts stay in
Claude's rollout files and are read back through `--resume`, so there is still exactly one record of any
conversation and Threads that Norvyn starts remain readable from the Claude Code CLI itself. This is the
narrowest store that makes the existing `ThreadStore` seam implementable, and it is deliberately not the
general-purpose SQLite database ADR-0001 considered.

Deleting narrows accordingly. CONTEXT.md says deleting Workspace History "permanently removes those Chat
records"; on this Provider it removes Norvyn's record, and the Claude Code rollout file is left where it is —
editing or deleting a Provider's rollout files is exactly what the code standard forbids. The Chat leaves
Norvyn's History and stays visible from Claude Code's own `/resume` picker. That is a real narrowing of the
user-facing promise and is documented in `docs/install.md` rather than hidden.

`branch` is the one capability with no honest implementation: `--fork-session` forks only the session being
resumed, with no way to cut the fork at a chosen Turn, so the Claude Adapter advertises `branch: false` and
the existing capability checks in `src/server.ts` refuse it. That is the mechanism from
[the code standard](../code-standard.md) working as intended — unsupported operations are declined against
advertised capabilities, not simulated.

## Considered Options

**Wrapping the Claude Agent SDK instead of the CLI** was rejected because the SDK is an API-key surface.
Norvyn exists to reuse a subscription the user already pays for, and CONTEXT.md's Local Session definition
rules out Norvyn holding Provider credentials at all. The CLI is the only Anthropic-owned local runtime that
already holds an authenticated session Norvyn can borrow without touching a credential.

**Parsing `~/.claude/projects/*.jsonl` directly to implement `ThreadStore`** was rejected even though it would
need no Norvyn-owned state. It couples Norvyn to an undocumented on-disk format that the CLI is free to change
between releases, it cannot represent pinning or renaming at all (there is nowhere to write them), and reading
every rollout file to build one history page scales with total transcript size rather than with Thread count.
Reading **one** rollout file to recover **one** Thread's transcript on resume has none of those problems, and
the Adapter does exactly that — best-effort, degrading to an empty transcript on any parse failure. What is
rejected is making History itself depend on the format, not touching it at all.

**Making the Claude Adapter emit its own protocol shapes** was rejected as too wide a change for a second
Provider. `Transport` and `ThreadStore` are Provider-neutral by name but Codex-shaped by type: they traffic in
`ServerNotificationEnvelope`, `Thread`, and `Turn` from the Codex-generated `schemas/`. The Claude Adapter
therefore translates its native events into those shapes, and everything above the seam — the server, the
browser client, approvals, history — is untouched. That leak is real and is named here so it is a known debt
rather than a discovery; retiring it means promoting a Norvyn-owned event vocabulary, which is a separate
decision this ADR does not make.

## Consequences

Provider selection is a **User Setting** — a global default — and a Thread is pinned to whichever Provider
started it, because its identifier, its transcript, and its resume path all belong to that Provider. Per-Chat
Provider choice and cross-Provider History in one list are both out of scope; History remains per-Provider for
the same reason ADR-0001 gave.

Local Session detection mirrors `checkPreflight` / `loginWithCodex`. `claude auth status` prints JSON
(`loggedIn`, `authMethod`, `subscriptionType`), so a missing session is a positive signal rather than a parsed
error string, and `claude auth login` runs the Provider-owned browser flow Norvyn only observes. Version
compatibility is enforced the same way as Codex's, against `claude --version`, with the same
minimum-version-and-upgrade-instruction failure. The minimum is a conservative floor rather than the exact
release that introduced them: `--input-format stream-json` and JSON-printing `claude auth status` are both
load-bearing, and neither is detectable except by version, so the floor is raised only against a release
verified to carry both.

Model discovery has no equivalent. Codex answers `model/list`; the Claude Code CLI accepts `--model` but will
not enumerate what the account may use, so the Claude Adapter advertises a curated catalog and the existing
unverified-custom-model path in User Settings carries anything outside it. A model the subscription does not
cover fails at the Turn rather than being filtered out beforehand.

Approvals do not reach this Transport at all. A headless `claude` decides tool use from `--permission-mode`
alone and offers no channel to ask, so the Adapter raises no approval requests and `answerRequest` is a no-op.
The seam compounds it: `Transport` never receives a Chat's Access Mode — Codex passes `on-request` and
resolves approvals through requests instead — so the Adapter launches at `manual` unconditionally, the Access
Mode a Thread starts at. Making Access Mode reach this Provider means widening the seam to carry it and
finding an ask channel; both are follow-up work, and until then Manual on Claude denies where it should ask.

Streaming is per message rather than per token. The CLI can emit token deltas under
`--include-partial-messages`, but reconciling those against the whole-message events that follow them is
avoidable complexity for a first implementation, so text currently arrives one assistant message at a time.

Two further gaps are accepted rather than solved. The Boundary's no-network guarantee is not enforceable
through the CLI's flags, so on the Claude Provider it holds only as far as permission prompts reach — this is
a real weakening of a CONTEXT.md guarantee and needs either an upstream mechanism or an explicit narrowing of
the Boundary's wording. And a per-Thread process pool costs a process and its startup per active Chat where
Codex costs one for all of them, which bounds how many Claude Chats can be live at once.
