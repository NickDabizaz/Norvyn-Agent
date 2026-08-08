import { isOlder, parseVersion, runProviderExecutable, type Preflight } from "./preflight.js";

/**
 * Conservative floor rather than the exact release that introduced them: Norvyn depends on
 * `--input-format stream-json` and on `claude auth status` printing JSON, and neither is detectable
 * except by version. Raise this only against a release that has been verified to carry both.
 */
const minimumVersion = [2, 0, 0];
const upgradeInstruction = "Update with: npm install -g @anthropic-ai/claude-code@latest";

/**
 * Reports whether a usable Claude Local Session exists, without ever reading a credential: the CLI is
 * asked for its own version and its own authentication status, and only those two answers are inspected.
 */
export async function checkClaudePreflight(claudePath?: string): Promise<Preflight> {
  const resolvedPath = claudePath?.trim() || "claude";
  if (process.env.NORVYN_SKIP_PREFLIGHT === "1")
    return { ok: true, kind: "ready", providerPath: resolvedPath, version: "test" };

  let version: string;
  try {
    const installed = parseVersion(await runClaude(["--version"], resolvedPath));
    if (!installed)
      return {
        ok: false,
        kind: "outdated",
        providerPath: resolvedPath,
        message: `Claude Code returned an unsupported version. Norvyn requires ${minimumVersion.join(".")}. ${upgradeInstruction}`,
      };
    version = installed.join(".");
    if (isOlder(installed, minimumVersion))
      return {
        ok: false,
        kind: "outdated",
        providerPath: resolvedPath,
        version,
        message: `Claude Code ${version} is too old. Norvyn requires ${minimumVersion.join(".")}, so streaming Turns are unavailable. ${upgradeInstruction}`,
      };
  } catch {
    return {
      ok: false,
      kind: "missing",
      providerPath: resolvedPath,
      message: `Claude Code is not installed. Install it with: npm install -g @anthropic-ai/claude-code@latest`,
    };
  }

  const session = await readLocalSession(resolvedPath);
  if (session !== "available")
    return {
      ok: false,
      kind: session,
      providerPath: resolvedPath,
      version,
      message:
        session === "expired"
          ? "The Claude Local Session has expired."
          : "No Claude Local Session is available.",
    };
  return { ok: true, kind: "ready", providerPath: resolvedPath, version };
}

/**
 * Triggers Claude Code's own browser sign-in flow and waits for it to finish. Norvyn observes only
 * whether the command succeeded; the credential it leaves behind is never read or stored by Norvyn.
 */
export async function loginWithClaude(
  claudePath?: string,
  timeoutMs = Number(process.env.NORVYN_LOGIN_TIMEOUT_MS ?? 300_000),
): Promise<void> {
  await runClaude(["auth", "login"], claudePath?.trim() || "claude", timeoutMs);
}

export async function validateClaudePath(claudePath: string): Promise<string> {
  const version = parseVersion(await runClaude(["--version"], claudePath));
  if (!version) throw new Error("The selected Claude executable did not report a supported version.");
  return version.join(".");
}

async function readLocalSession(claudePath: string): Promise<"available" | "signed-out" | "expired"> {
  let output: string;
  try {
    output = await runClaude(["auth", "status"], claudePath);
  } catch (error) {
    // A non-zero exit is how the CLI reports "not signed in"; only an explicit expiry is distinguishable.
    return error instanceof Error && /expired/i.test(error.message) ? "expired" : "signed-out";
  }
  const status = parseAuthStatus(output);
  if (status?.loggedIn === true) return "available";
  if (status?.expired === true) return "expired";
  return "signed-out";
}

/**
 * `claude auth status` prints a JSON object, but may print progress lines around it. Only the object is
 * read, and only its `loggedIn` flag is trusted — never the account fields that sit beside it.
 */
export function parseAuthStatus(output: string): { loggedIn: boolean; expired: boolean } | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
    return { loggedIn: value.loggedIn === true, expired: value.expired === true };
  } catch {
    return undefined;
  }
}

function runClaude(args: string[], claudePath: string, timeoutMs?: number): Promise<string> {
  return runProviderExecutable({
    label: "Claude",
    executablePath: claudePath,
    args,
    timeoutMs,
    overrideCommand: process.env.NORVYN_CLAUDE_COMMAND,
    overrideArguments: process.env.NORVYN_CLAUDE_ARGUMENTS,
  });
}
