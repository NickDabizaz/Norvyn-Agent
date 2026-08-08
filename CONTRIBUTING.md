# Contributing

Use Node.js 22 on Windows, create a focused branch, and keep changes aligned with
[`docs/code-standard.md`](docs/code-standard.md) and [`CONTEXT.md`](CONTEXT.md).

Before submitting a change, run:

```powershell
npm ci
npm run verify
```

UI changes must also follow the [UI delivery quality gate](docs/ui-quality.md), including its issue readiness,
browser screenshot, keyboard, focus, contrast, zoom, scroll, and cleanup requirements.

Provider behavior in tests must use local fakes. Do not commit credentials, Provider history, generated build
output, telemetry, or a hosted deployment configuration.
