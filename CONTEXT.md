# Norvyn Agent

A local-first, open source personal AI assistant. It reaches models through the subscriptions the user already
pays for — reusing the authenticated sessions of each vendor's own local agent runtime — rather than through
metered API keys.

## Language

### Reaching a model

**Provider**: A model vendor together with the subscription that grants access to it — OpenAI (via ChatGPT),
Anthropic (via Claude), Google (via Gemini). A Provider is _who_ the models come from, never _how_ they are
reached. _Avoid_: Vendor, backend, service

**Transport**: The concrete mechanism for talking to one Provider — for OpenAI, the Codex app-server spoken to
over JSON-RPC on stdio. A Provider may have more than one Transport, so the two are never used
interchangeably. _Avoid_: Driver, connector, integration, client

**Local Session**: The authenticated state a Provider's own tooling has already established on this machine,
which Norvyn borrows rather than creates. For OpenAI this is what `codex login` leaves behind. Norvyn may
trigger that Provider-owned browser login flow and observe whether it succeeds, but it never receives the
user's password, stores Provider credentials, or implements its own sign-in protocol. _Avoid_: Login
injection, credential injection, token, account

### Conversation

**Thread**: One continuing conversation, identified by the Provider's own identifier. This is the domain term;
the user-facing word for the same thing is **Chat**. _Avoid_: Session (reserved for Local Session), room,
channel

**Turn**: One user message together with the agent's complete response to it. A Thread is a sequence of Turns,
and a Turn is the smallest unit that can be started, streamed, and completed. _Avoid_: Message, exchange,
round-trip

**Workspace**: The directory a Thread is anchored to, and the outer bound of everything the agent may touch on
that Thread. Every Thread has exactly one; it defaults to the directory Norvyn was launched from. _Avoid_:
Project, folder, cwd, working directory

**Workspace History**: The set of Provider-owned Chats anchored to the same Workspace. Archiving it hides
those Chats from active History while keeping them recoverable; deleting it permanently removes those Chat
records. Neither action deletes or modifies the Workspace directory or any file inside it. _Avoid_: Delete
Workspace, delete project, remove folder

### Work tracking

**Kanban Board**: The single work-tracking view owned by one Workspace. It contains every Work Plan for that
Workspace, including plans created from different Chats. _Avoid_: Task board, project board

**Work Plan**: A substantial user outcome tracked on a Kanban Board and linked to the Chat from which it was
created. A Work Plan is decomposed into Work Items. _Avoid_: Task, Chat plan, Turn plan

**Work Item**: One independently trackable unit of a Work Plan, with enough scope to complete and verify as a
unit. The user-facing label may be **Task**. _Avoid_: Turn, message, card

**Execution Attempt**: One attempt by one worker Chat to complete a Work Item. A Work Item retains its earlier
attempts when retried, but has at most one active Execution Attempt. _Avoid_: Run, retry Chat, agent task

**Coordinator Chat**: The Chat from which a Work Plan was created and which coordinates its Work Items and
reports their combined outcome. Worker Chats remain separate Chats linked through Execution Attempts. _Avoid_:
Parent task, master agent

**Execution Mode**: How a Work Plan progresses: **Track Only** records work without starting worker Chats,
**Guided** asks before starting them, and **Autonomous** starts ready work within configured limits. _Avoid_:
Access Mode, permission mode

**Workspace Lesson**: A concise, user-approved lesson learned from completed work or a resolved defect and
made available to relevant future work in the same Workspace. It is not shared across Workspaces by default.
_Avoid_: Global memory, Chat history, transcript memory

### Permission

**Access Mode**: How much the agent may do on a Thread without stopping to ask — one of **Manual** (asks
before writing files and before running commands), **Auto Edit** (writes freely, asks before running
commands), or **Auto** (asks for nothing). Chosen per Thread, and always Manual until deliberately raised.
_Avoid_: Permission level, trust level, YOLO mode

**Boundary**: What no Access Mode can widen: only the Workspace is writable, and the agent has no network
access. Access Mode governs _what gets asked_; the Boundary governs _what is possible at all_, so raising the
former never breaches the latter. _Avoid_: Sandbox, guardrails, restrictions

### Configuration

**User Settings**: Persistent local preferences that configure Norvyn across Chats. They never contain Thread
history, Provider credentials, or an Access Mode default. _Avoid_: Account settings, cloud settings
