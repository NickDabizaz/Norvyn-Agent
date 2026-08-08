import { spawn } from "node:child_process";

const minimumVersion = [0, 146, 1];

export type Preflight =
  | { ok: true; kind: "ready"; providerPath: string; version: string }
  | {
      ok: false;
      kind: "missing" | "outdated" | "signed-out" | "expired";
      providerPath: string;
      version?: string;
      message: string;
    };

export async function checkPreflight(codexPath?: string): Promise<Preflight> {
  const resolvedPath = codexPath?.trim() || "codex";
  if (process.env.NORVYN_SKIP_PREFLIGHT === "1")
    return { ok: true, kind: "ready", providerPath: resolvedPath, version: "test" };
  let version: string;
  try {
    const installed = parseVersion(await runCodex(["--version"], resolvedPath));
    if (!installed)
      return {
        ok: false,
        kind: "outdated",
        providerPath: resolvedPath,
        message: `Codex CLI returned an unsupported version. Norvyn requires ${minimumVersion.join(".")}. Update with: npm install -g @openai/codex@latest`,
      };
    version = installed.join(".");
    if (isOlder(installed, minimumVersion)) {
      return {
        ok: false,
        kind: "outdated",
        providerPath: resolvedPath,
        version,
        message: `Codex CLI ${version} is too old. Norvyn requires ${minimumVersion.join(".")}, so supported models are unavailable. Update with: npm install -g @openai/codex@latest`,
      };
    }
  } catch {
    return {
      ok: false,
      kind: "missing",
      providerPath: resolvedPath,
      message: "Codex CLI is not installed. Install it with: npm install -g @openai/codex@latest",
    };
  }
  try {
    const status = await runCodex(["login", "status"], resolvedPath);
    if (!/logged in/i.test(status)) throw new Error("not logged in");
  } catch (error) {
    const expired = error instanceof Error && /expired/i.test(error.message);
    return {
      ok: false,
      kind: expired ? "expired" : "signed-out",
      providerPath: resolvedPath,
      version,
      message: expired ? "The Codex Local Session has expired." : "No Codex Local Session is available.",
    };
  }
  return { ok: true, kind: "ready", providerPath: resolvedPath, version };
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

/** Reads the first dotted triple a Provider CLI prints for `--version`. */
export function parseVersion(output: string): number[] | undefined {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

/** True when `installed` precedes `minimum`; both are dotted triples from {@link parseVersion}. */
export function isOlder(installed: number[], minimum: number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (installed[index] < minimum[index]) return true;
    if (installed[index] > minimum[index]) return false;
  }
  return false;
}

function runCodex(args: string[], codexPath: string, timeoutMs = 30_000): Promise<string> {
  return runProviderExecutable({
    label: "Codex",
    executablePath: codexPath,
    args,
    timeoutMs,
    overrideCommand: process.env.NORVYN_PROVIDER_COMMAND,
    overrideArguments: process.env.NORVYN_PROVIDER_ARGUMENTS,
  });
}

export interface ProviderExecutableRun {
  /** Provider-facing name used in timeout and failure messages, e.g. `Codex` or `Claude`. */
  label: string;
  executablePath: string;
  args: string[];
  timeoutMs?: number;
  /** Test seam: replaces the executable entirely when set. */
  overrideCommand?: string;
  /** JSON-encoded argument array prepended to `args` when `overrideCommand` is set. */
  overrideArguments?: string;
}

/**
 * Runs one short-lived Provider CLI command and resolves with its combined output. Reject means the
 * command failed, timed out, or could not be spawned; the rejection message carries the CLI's own output.
 */
export function runProviderExecutable(run: ProviderExecutableRun): Promise<string> {
  const { label, executablePath, args, timeoutMs = 30_000, overrideCommand } = run;
  const overrideArguments = run.overrideArguments ? (JSON.parse(run.overrideArguments) as string[]) : [];
  const command =
    overrideCommand ?? (process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : executablePath);
  const executable = safeExecutablePath(executablePath);
  const commandArgs = overrideCommand
    ? [...overrideArguments, ...args]
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
      reject(new Error(`${label} operation timed out.`));
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
      else reject(new Error(output.trim() || `${label} operation failed or was cancelled.`));
    });
  });
}

export function safeExecutablePath(executablePath: string): string {
  const result = executablePath.trim();
  if (!result || /[&|<>^"%!()\r\n]/.test(result))
    throw new Error("The Provider executable path contains unsupported command characters.");
  return result.includes(" ") ? `"${result}"` : result;
}
