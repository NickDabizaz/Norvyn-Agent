# UI delivery quality gate

This guide is the repository-owned contract for human and AI contributors who change Norvyn's browser
experience. Use the terms in [CONTEXT.md](../CONTEXT.md): a Chat is the Provider-owned conversation shown in
the browser, Workspace History is the Provider-owned list grouped by Workspace, and a Turn is one user request
plus the Provider response.

## Ready for implementation

A UI issue is ready for an agent only when it records all of the following:

- the observable user outcome and explicit non-goals;
- reference screenshots or precise visual details, including what must remain unchanged;
- target viewports, with at least `1024×768` and `1440×900` for desktop work and 200% browser zoom when the
  affected flow is primary;
- keyboard order, focus entry/exit/restoration, accessible names, reduced-motion behavior, and expected screen
  reader state;
- browser commands and server events at the shared protocol boundary;
- empty, loading, success, error, disabled, overflow, and destructive states;
- relevant cardinalities and extremes: 0, 1, 5, 6, and many items, long text, and long Workspace paths.

Keep one scoped issue per user outcome. Do not combine unrelated review feedback into one change. The final
commit must be atomic and link the issue, for example `fix(history): preserve divider focus (#123)`.

## Protocol and Boundary rules

- Secrets and bootstrap access values never appear in query strings, logs, screenshots, DOM text, errors, or
  diagnostics exports. Bootstrap access uses the URL fragment and is exchanged immediately for an HttpOnly
  local session.
- HTTP mutations use `POST`; static reads use `GET`; realtime browser interaction uses the authenticated
  WebSocket.
- Decode browser commands and server events before feature logic. Browser-visible errors use a stable scope,
  code, human message, and recovery action without raw Provider payloads.
- Provider authentication, history, model capability discovery, and execution stay on the Provider side of the
  Agent Boundary described by the architecture decisions.

## Definition of done

1. Add a failing outside-in reproduction before the implementation. For escaped defects, first add the
   violated invariant to this guide or the appropriate domain document.
2. Implement the narrowest durable fix and add permanent regression coverage through a feature seam.
3. Exercise 0/1/5/6/many and long-content states when relevant.
4. Capture and inspect browser screenshots at the target viewports. Check contrast, visible focus, keyboard
   operation, focus restoration, scrolling, composer visibility, 200% zoom, and reduced motion.
5. Run `npm run verify`. Narrower commands are useful while iterating, but they do not satisfy this gate.
6. Review the complete diff for secrets, raw colors outside semantic tokens, unrelated edits, generated
   output, and temporary files. Confirm browser tests left no server process or output artifact.
7. Commit the scoped change atomically with its issue number before pushing.

Every escaped defect becomes both a documented invariant and a regression test before its issue is complete.
This workflow is local-first: it requires the fake Provider and local verification, not CI/CD, a Provider
login, an API key, or a model call.
