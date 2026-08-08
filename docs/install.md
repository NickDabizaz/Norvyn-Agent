# Install Norvyn on Windows

## Requirements

- Windows 10 or 11
- Node.js 22 or newer (`node --version`)
- One Provider's own CLI, plus a Local Session it has already authenticated. Norvyn can trigger that
  Provider-owned sign-in flow from its browser screen, and never receives your password or stores Provider
  credentials.

| Provider               | CLI to install                                    | Sign in with        |
| ---------------------- | ------------------------------------------------- | ------------------- |
| OpenAI (via ChatGPT)   | `npm install -g @openai/codex@latest`             | `codex login`       |
| Anthropic (via Claude) | `npm install -g @anthropic-ai/claude-code@latest` | `claude auth login` |

Install only the one you intend to use. OpenAI is the default; switch in **User Settings → Provider**.

## Install and launch

```powershell
npm install -g norvyn
cd C:\path\to\your\workspace
norvyn
```

Norvyn prints and opens a token-gated loopback URL. Keep that browser tab private while Norvyn is running.

## Choosing a Provider

Provider is a User Setting and applies to every new Chat. Saving a new Provider reconnects Norvyn to that
Provider's CLI and reloads its models. A Chat stays with the Provider that started it, so History is listed
per Provider rather than merged: switching Provider changes which Chats you see, and switching back brings the
others into view again. See [ADR-0005](adr/0005-claude-code-cli-is-the-claude-transport.md).

Two things differ on the Claude Provider today. Branching a Chat is unavailable, because Claude Code cannot
fork a conversation at a chosen Turn. And Norvyn keeps its own small index of Claude Chats — identifiers,
Workspace, name, pinned and archived state — at `%USERPROFILE%\.norvyn\threads.json`, because Claude Code
exposes no way to list or organise its sessions. Transcripts are not copied there; deleting a Chat removes
Norvyn's record of it and leaves Claude Code's own transcript file untouched.

## Troubleshooting

- **`node` is not recognized:** install Node.js 22 and reopen the terminal.
- **Codex is missing or too old:** run `npm install -g @openai/codex@latest`.
- **Claude Code is missing or too old:** run `npm install -g @anthropic-ai/claude-code@latest`.
- **Not Connected:** select **Connect With Codex** or **Connect With Claude** and finish that Provider's
  browser flow, or verify with `codex login status` / `claude auth status`.
- **`norvyn` is not recognized:** reopen the terminal after the global install and confirm npm's global binary
  directory is on `PATH`.
- **Provider will not start:** open **Diagnostics** in Norvyn, review the specific recovery action, and retry
  or restart the Provider.

Norvyn has no hosted runtime, Docker image, VPS deployment, API-key requirement, analytics, or telemetry.
