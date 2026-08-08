# Install Norvyn on Windows

## Requirements

- Windows 10 or 11
- Node.js 22 or newer (`node --version`)
- Codex CLI (`npm install -g @openai/codex@latest`)
- A ChatGPT-backed Codex Local Session. Norvyn can trigger Codex's Provider-owned sign-in flow from its
  browser screen and never receives your password or stores Provider credentials.

## Install and launch

```powershell
npm install -g norvyn
cd C:\path\to\your\workspace
norvyn
```

Norvyn prints and opens a token-gated loopback URL. Keep that browser tab private while Norvyn is running.

## Troubleshooting

- **`node` is not recognized:** install Node.js 22 and reopen the terminal.
- **Codex is missing or too old:** run `npm install -g @openai/codex@latest`.
- **Not Connected:** select **Connect With Codex** and finish Codex's browser flow, or verify with
  `codex login status`.
- **`norvyn` is not recognized:** reopen the terminal after the global install and confirm npm's global binary
  directory is on `PATH`.
- **Provider will not start:** open **Diagnostics** in Norvyn, review the specific recovery action, and retry
  or restart the Provider.

Norvyn has no hosted runtime, Docker image, VPS deployment, API-key requirement, analytics, or telemetry.
