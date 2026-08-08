# Norvyn Agent

A local-first, open source personal AI assistant. It reaches models through the
subscriptions the user already pays for — reusing the authenticated sessions of
each vendor's own local agent runtime — rather than through metered API keys.

## Language

### Reaching a model

**Provider**:
A model vendor together with the subscription that grants access to it — OpenAI
(via ChatGPT), Anthropic (via Claude), Google (via Gemini). A Provider is *who*
the models come from, never *how* they are reached.
_Avoid_: Vendor, backend, service

**Transport**:
The concrete mechanism for talking to one Provider — for OpenAI, the Codex
app-server spoken to over JSON-RPC on stdio. A Provider may have more than one
Transport, so the two are never used interchangeably.
_Avoid_: Driver, connector, integration, client

**Local Session**:
The authenticated state a Provider's own tooling has already established on this
machine, which Norvyn borrows rather than creates. For OpenAI this is what
`codex login` leaves behind. Norvyn never handles the user's password, never
stores credentials, and never performs a sign-in itself.
_Avoid_: Login injection, credential injection, token, account

### Conversation

**Thread**:
One continuing conversation, identified by the Provider's own identifier. This is
the domain term; the user-facing word for the same thing is **Chat**.
_Avoid_: Session (reserved for Local Session), room, channel

**Turn**:
One user message together with the agent's complete response to it. A Thread is a
sequence of Turns, and a Turn is the smallest unit that can be started, streamed,
and completed.
_Avoid_: Message, exchange, round-trip

**Workspace**:
The directory a Thread is anchored to, and the outer bound of everything the
agent may touch on that Thread. Every Thread has exactly one; it defaults to the
directory Norvyn was launched from.
_Avoid_: Project, folder, cwd, working directory

**Workspace History**:
The set of Provider-owned Chats anchored to the same Workspace. Archiving it
hides those Chats from active History while keeping them recoverable; deleting
it permanently removes those Chat records. Neither action deletes or modifies
the Workspace directory or any file inside it.
_Avoid_: Delete Workspace, delete project, remove folder

### Permission

**Access Mode**:
How much the agent may do on a Thread without stopping to ask — one of **Manual**
(asks before writing files and before running commands), **Auto Edit** (writes
freely, asks before running commands), or **Auto** (asks for nothing). Chosen per
Thread, and always Manual until deliberately raised.
_Avoid_: Permission level, trust level, YOLO mode

**Boundary**:
What no Access Mode can widen: only the Workspace is writable, and the agent has
no network access. Access Mode governs *what gets asked*; the Boundary governs
*what is possible at all*, so raising the former never breaches the latter.
_Avoid_: Sandbox, guardrails, restrictions

### Configuration

**User Settings**:
Persistent local preferences that configure Norvyn across Chats. They never
contain Thread history, Provider credentials, or an Access Mode default.
_Avoid_: Account settings, cloud settings
