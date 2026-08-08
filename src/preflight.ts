import { spawn } from "node:child_process";

const minimumVersion = [0, 146, 1];

export type Preflight =
  | { ok: true; kind: "ready"; codexPath: string; version: string }
  | {
      ok: false;
      kind: "missing" | "outdated" | "signed-out";
      codexPath: string;
      version?: string;
      message: string;
    };

export async function checkPreflight(codexPath?: string): Promise<Preflight> {
  const resolvedPath = codexPath?.trim() || "codex";
  if (process.env.NORVYN_SKIP_PREFLIGHT === "1")
    return { ok: true, kind: "ready", codexPath: resolvedPath, version: "test" };
  let version: string;
  try {
    const output = await runCodex(["--version"], resolvedPath);
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match)
      return {
        ok: false,
        kind: "outdated",
        codexPath: resolvedPath,
        message: `Codex CLI returned an unsupported version. Norvyn requires ${minimumVersion.join(".")}. Update with: npm install -g @openai/codex@latest`,
      };
    const installed = match.slice(1).map(Number);
    version = installed.join(".");
    if (isOlder(installed, minimumVersion)) {
      return {
        ok: false,
        kind: "outdated",
        codexPath: resolvedPath,
        version,
        message: `Codex CLI ${version} is too old. Norvyn requires ${minimumVersion.join(".")}, so supported models are unavailable. Update with: npm install -g @openai/codex@latest`,
      };
    }
  } catch {
    return {
      ok: false,
      kind: "missing",
      codexPath: resolvedPath,
      message: "Codex CLI is not installed. Install it with: npm install -g @openai/codex@latest",
    };
  }
  try {
    const status = await runCodex(["login", "status"], resolvedPath);
    if (!/logged in/i.test(status)) throw new Error("not logged in");
  } catch {
    return {
      ok: false,
      kind: "signed-out",
      codexPath: resolvedPath,
      version,
      message: "No Codex Local Session is available.",
    };
  }
  return { ok: true, kind: "ready", codexPath: resolvedPath, version };
}

export async function loginWithCodex(
  codexPath?: string,
  timeoutMs = Number(process.env.NORVYN_LOGIN_TIMEOUT_MS ?? 300_000),
): Promise<void> {
  const resolvedPath = codexPath?.trim() || "codex";
  await runCodex(["login"], resolvedPath, timeoutMs);
}

export async function validateCodexPath(codexPath: string): Promise<string> {
  const output = await runCodex(["--version"], codexPath);
  const version = output.match(/(\d+\.\d+\.\d+)/)?.[1];
  if (!version) throw new Error("The selected Codex executable did not report a supported version.");
  return version;
}

function isOlder(installed: number[], minimum: number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (installed[index] < minimum[index]) return true;
    if (installed[index] > minimum[index]) return false;
  }
  return false;
}

function runCodex(args: string[], codexPath: string, timeoutMs = 30_000): Promise<string> {
  const configuredCommand = process.env.NORVYN_PROVIDER_COMMAND;
  const configuredArguments = process.env.NORVYN_PROVIDER_ARGUMENTS
    ? (JSON.parse(process.env.NORVYN_PROVIDER_ARGUMENTS) as string[])
    : [];
  const command =
    configuredCommand ?? (process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : codexPath);
  const executable = codexPath.includes(" ") ? `"${codexPath.replaceAll('"', "")}"` : codexPath;
  const commandArgs = configuredCommand
    ? [...configuredArguments, ...args]
    : process.platform === "win32"
      ? ["/d", "/s", "/c", `${executable} ${args.join(" ")}`]
      : args;
  const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Codex operation timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error("Codex operation failed or was cancelled."));
    });
  });
}
