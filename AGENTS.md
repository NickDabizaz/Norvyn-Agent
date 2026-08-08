# Norvyn Agent

A local-first, open source personal AI assistant. Norvyn reaches models through the subscriptions you already
pay for by borrowing the authenticated session of each vendor's own local agent runtime, rather than through
metered API keys.

Everything committed to this repository is written in English.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### UI delivery

Browser-interface issues and changes follow `docs/ui-quality.md`. An agent must run `npm run verify` before
declaring work complete and before pushing; narrower checks are iteration aids only.

### Code standard

All implementation work follows `docs/code-standard.md`; its lint, protocol-boundary, module-interface, and
CSS rules are mandatory.
