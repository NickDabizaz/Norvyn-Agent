# Norvyn

Norvyn is a local-first personal AI assistant for Windows. It opens a browser interface on your machine and
reuses a ChatGPT-backed Codex Local Session; it does not upload your Workspace to a hosted Norvyn service.

## Install

Requirements: Windows, Node.js 22 or newer, and the Codex CLI.

```powershell
npm install -g @openai/codex@latest
npm install -g norvyn
norvyn
```

Run `norvyn` inside the directory you want to use as the initial Workspace. See the
[installation guide](docs/install.md) for setup and troubleshooting.

## Development

```powershell
npm ci
npm run verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md), the [code standard](docs/code-standard.md), and the
[domain glossary](CONTEXT.md).

Maintainers can find the trusted-publishing setup in [docs/releasing.md](docs/releasing.md).

Norvyn is available under the [MIT License](LICENSE).
