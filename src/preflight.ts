import { spawn } from "node:child_process";

const minimumVersion = [0, 146, 1];

export type Preflight = { ok: true } | { ok: false; message: string };

export async function checkPreflight(): Promise<Preflight> {
  if (process.env.NORVYN_SKIP_PREFLIGHT === "1") return { ok: true };
  try {
    const version = await runCodex(["--version"]);
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return { ok: false, message: `Codex CLI returned an unsupported version. Norvyn requires ${minimumVersion.join(".")}, so supported models are unavailable. Update with: npm install -g @openai/codex@latest` };
    const installed = match.slice(1).map(Number);
    if (isOlder(installed, minimumVersion)) {
      return { ok: false, message: `Codex CLI ${installed.join(".")} is too old. Norvyn requires ${minimumVersion.join(".")}, so supported models are unavailable. Update with: npm install -g @openai/codex@latest` };
    }
  } catch {
    return { ok: false, message: "Codex CLI is not installed. Install it with: npm install -g @openai/codex@latest" };
  }
  try {
    const status = await runCodex(["login", "status"]);
    if (!/logged in/i.test(status)) throw new Error("not logged in");
  } catch {
    return { ok: false, message: "No Local Session was found. Sign in with: codex login" };
  }
  return { ok: true };
}

function isOlder(installed: number[], minimum: number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (installed[index] < minimum[index]) return true;
    if (installed[index] > minimum[index]) return false;
  }
  return false;
}

function runCodex(args: string[]): Promise<string> {
  const configuredCommand = process.env.NORVYN_PROVIDER_COMMAND;
  const configuredArguments = process.env.NORVYN_PROVIDER_ARGUMENTS ? JSON.parse(process.env.NORVYN_PROVIDER_ARGUMENTS) as string[] : [];
  const command = configuredCommand ?? (process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "codex");
  const commandArgs = configuredCommand ? [...configuredArguments, ...args] : process.platform === "win32" ? ["/d", "/s", "/c", `codex ${args.join(" ")}`] : args;
  const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => output += chunk);
    child.stderr.on("data", (chunk) => output += chunk);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error("Codex command failed")));
  });
}
