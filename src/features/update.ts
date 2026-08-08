import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface UpdateInfo {
  installed: string;
  available: string;
}
export type RegistryFetcher = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
export interface Installer {
  install(version: string, onProgress: (line: string) => void): Promise<void>;
}

export async function checkForUpdate(
  installed: string,
  enabled: boolean,
  fetcher: RegistryFetcher = fetch,
): Promise<UpdateInfo | undefined> {
  if (!enabled) return undefined;
  try {
    const response = await fetcher("https://registry.npmjs.org/norvyn/latest", {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string" || !isNewer(body.version, installed)) return undefined;
    return { installed, available: body.version };
  } catch {
    return undefined;
  }
}

export function updateCommand(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid package version.");
  return `npm install -g norvyn@${version}`;
}

export class NpmInstaller implements Installer {
  install(version: string, onProgress: (line: string) => void): Promise<void> {
    const command = updateCommand(version);
    const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
    const args =
      process.platform === "win32" ? ["/d", "/s", "/c", command] : ["install", "-g", `norvyn@${version}`];
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    createInterface({ input: child.stdout }).on("line", onProgress);
    createInterface({ input: child.stderr }).on("line", onProgress);
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`npm exited with code ${code ?? "unknown"}.`)),
      );
    });
  }
}

export async function performConfirmedUpdate(
  version: string,
  confirmed: boolean,
  installer: Installer,
  onProgress: (line: string) => void,
): Promise<void> {
  updateCommand(version);
  if (!confirmed) throw new Error("Updating Norvyn requires explicit confirmation.");
  await installer.install(version, onProgress);
}

export function isNewer(candidate: string, installed: string): boolean {
  const left = numericVersion(candidate);
  const right = numericVersion(installed);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return false;
}

function numericVersion(value: string): number[] {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return match.slice(1).map(Number);
}
