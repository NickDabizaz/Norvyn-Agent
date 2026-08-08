# Norvyn owns work-tracking state

Norvyn stores each Workspace's Kanban Board, Work Plans, Work Items, Execution Attempts, and Workspace Lessons
in Norvyn-owned local application data. This state remains separate from Provider-owned conversation history
and from files inside the Workspace: Providers do not offer the durable dependency and execution model the
Board requires, while silently writing tracking files into a user's Workspace would change that Workspace
without an explicit request.

## Consequences

Board data remains available while Providers are disconnected and survives Norvyn restarts. Deleting Board
data never deletes Provider Chats or Workspace files, and Provider history remains governed by ADR-0001 rather
than being duplicated into this store.
