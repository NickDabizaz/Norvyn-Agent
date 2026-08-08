import { existsSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const args = process.argv.slice(3);
const loginMarker = process.env.NORVYN_FAKE_LOGIN_MARKER;

if (args[0] === "--version") {
  process.stdout.write(mode === "old" ? "codex-cli 0.1.0\n" : "codex-cli 0.146.1\n");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  if (mode === "expired" && (!loginMarker || !existsSync(loginMarker))) {
    process.stderr.write("Codex Local Session expired\n");
    process.exit(1);
  }
  if (
    ["signed-out", "login-fails", "login-cancelled", "login-timeout"].includes(mode) &&
    (!loginMarker || !existsSync(loginMarker))
  )
    process.exit(1);
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}

if (args[0] === "login") {
  if (mode === "login-fails") {
    process.stderr.write("Provider sign-in failed\n");
    process.exit(1);
  }
  if (mode === "login-cancelled") {
    process.stderr.write("Provider sign-in cancelled\n");
    process.exit(1);
  }
  if (mode === "login-timeout") {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    process.exit(0);
  }
  if (loginMarker) writeFileSync(loginMarker, "connected");
  process.exit(0);
}

process.exit(1);
