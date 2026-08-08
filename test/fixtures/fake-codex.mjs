import { existsSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const args = process.argv.slice(3);
const loginMarker = process.env.NORVYN_FAKE_LOGIN_MARKER;

if (args[0] === "--version") {
  process.stdout.write(mode === "old" ? "codex-cli 0.1.0\n" : "codex-cli 0.146.1\n");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  if (mode === "signed-out" && (!loginMarker || !existsSync(loginMarker))) process.exit(1);
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}

if (args[0] === "login") {
  if (mode === "login-fails") process.exit(1);
  if (loginMarker) writeFileSync(loginMarker, "connected");
  process.exit(0);
}

process.exit(1);
