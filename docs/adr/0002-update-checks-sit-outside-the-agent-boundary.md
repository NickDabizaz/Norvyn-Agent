# Update checks sit outside the agent Boundary

Norvyn may make a read-only request to the npm registry for published version metadata, but the agent and
Provider remain unable to access the network. The update checker sends no Workspace, Thread, or usage data,
performs no telemetry, and may install an update only after an explicit user action.
