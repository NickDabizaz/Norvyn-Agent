# Installation bootstraps through npx; Node.js remains the one prerequisite Norvyn cannot install

Norvyn's end-user installation and first run is one command, `npx norvyn`: it runs preflight checks and opens
the local UI in the same step already implemented in `src/cli.ts`. On a successful first run it offers, with
an explicit yes/no confirmation, to install itself globally so the daily-use command becomes plain `norvyn` —
fast, with no repeated network round-trip through npm on every launch. The same confirm-first pattern governs
every other system change Norvyn makes on the user's behalf: installing or updating the Codex CLI when
`src/preflight.ts` finds it missing or outdated, and installing an available Norvyn update. Norvyn asks once
per action and never mutates global state silently.

Node.js is the one exception, and deliberately so: `npx` itself requires Node.js already on the machine to run
at all, so no Node-based flow can install its own runtime. It stays the single prerequisite documented as a
manual step, with a direct link to nodejs.org on the landing page.

## Considered Options

Two alternatives were rejected. A pure-npx-forever flow, with no persistent global install, was simpler to
document but meant every daily launch depended on network access and an npm registry round-trip — directly at
odds with Norvyn being local-first. A native, Node-free installer script (`curl | bash` / `irm | iex`,
matching Claude Code's install page) would remove Node.js as a prerequisite entirely, but requires packaging
Norvyn as a self-contained per-OS executable, hosting the install script, and handling Windows
SmartScreen/code-signing trust — real infrastructure this MVP does not have yet. It remains worth revisiting
once Norvyn has a reason to invest in that packaging. Today's two-step `npm install -g @openai/codex` then
`npm install -g norvyn` flow, the friction this decision replaces, was rejected outright.

## Consequences

The installation redesign is scoped to end users; the contributor path (`git clone`, `npm ci`,
`npm run verify`) is untouched. It also stays Windows-only, matching Norvyn's current product positioning —
going cross-platform is a separate decision this ADR does not make.

Update checks keep the read-only, no-telemetry npm registry request from ADR-0002, but its "explicit user
action" now means an interactive confirm prompt rather than a printed instruction, and the check fails
silently offline rather than blocking startup — Norvyn must launch the same whether or not the network is
reachable. Uninstall and repair get no dedicated tooling: both reduce to the standard `npm uninstall -g` and
re-running the same global-install command, documented in `docs/install.md` rather than built as commands,
since the install path is already the symmetric, copy-pasteable answer to both.

`norvyn` has never been published to npm, so none of this crosses an existing user base — there is no
migration to design around.
