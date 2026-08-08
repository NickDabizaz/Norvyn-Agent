# Docker Containerization

Norvyn v1 is distributed as a Windows-local npm CLI that opens its browser UI. Docker is not a supported
runtime or distribution format.

## Why this is out of scope

Norvyn depends on resources that already belong to the host: the Codex CLI, its Provider-owned Local Session,
and the local Workspace selected for a Thread. A container would require mounting or copying each of those
resources and would complicate browser callbacks, filesystem boundaries, and authentication without improving
the intended local installation path.

The supported v1 path remains running Norvyn directly on the user's Windows machine through npm.
Containerization can be reconsidered if Norvyn later adopts a runtime architecture that does not depend on
host-local Provider state.

## Prior requests

- #21 — "Add optimized multi-stage Dockerfile for the project"
