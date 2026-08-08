import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UserSettings } from "./protocol.js";

export const DEFAULT_SETTINGS: UserSettings = {
  version: 1,
  provider: "openai",
  customModels: [],
  versionChecks: false,
  textScale: "medium",
  transcriptDensity: "comfortable",
};

export interface SettingsLoadResult {
  settings: UserSettings;
  warning?: string;
  migrated: boolean;
}

export function settingsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.NORVYN_CONFIG ?? join(homedir(), ".norvyn", "config.json");
}

export async function loadUserSettings(path = settingsPath()): Promise<SettingsLoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { settings: { ...DEFAULT_SETTINGS }, migrated: false };
    return {
      settings: { ...DEFAULT_SETTINGS },
      warning: `User Settings could not be read: ${safeMessage(error)}`,
      migrated: false,
    };
  }

  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const migrated = value.version !== 1;
    const settings = migrated ? migrateLegacySettings(value) : normalizeSettings(value);
    return { settings, migrated };
  } catch (error) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      warning: `User Settings were invalid and defaults are being used. Fix or replace ${path}: ${safeMessage(error)}`,
      migrated: false,
    };
  }
}

export async function saveUserSettings(settings: UserSettings, path = settingsPath()): Promise<UserSettings> {
  const normalized = normalizeSettings(settings as unknown as Record<string, unknown>);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return normalized;
}

export function normalizeSettings(value: Record<string, unknown>): UserSettings {
  const customModels = stringList(value.customModels ?? []);
  const defaultModel = optionalString(value.defaultModel, "defaultModel");
  const codexPath = optionalString(value.codexPath, "codexPath");
  const claudePath = optionalString(value.claudePath, "claudePath");
  const provider = value.provider ?? DEFAULT_SETTINGS.provider;
  if (!isOneOf(provider, ["openai", "anthropic"] as const))
    throw new Error("provider must be openai or anthropic");
  const versionChecks = value.versionChecks ?? DEFAULT_SETTINGS.versionChecks;
  if (typeof versionChecks !== "boolean") throw new Error("versionChecks must be true or false");
  const textScale = value.textScale ?? DEFAULT_SETTINGS.textScale;
  if (!isOneOf(textScale, ["small", "medium", "large"] as const))
    throw new Error("textScale must be small, medium, or large");
  const transcriptDensity = value.transcriptDensity ?? DEFAULT_SETTINGS.transcriptDensity;
  if (!isOneOf(transcriptDensity, ["comfortable", "compact"] as const))
    throw new Error("transcriptDensity must be comfortable or compact");
  return {
    version: 1,
    provider,
    customModels,
    defaultModel,
    codexPath,
    claudePath,
    versionChecks,
    textScale,
    transcriptDensity,
  };
}

export interface ProviderModelCatalog {
  models: string[];
  unverifiedModels: string[];
  defaultModel?: string;
  error?: string;
}

export function providerModelCatalog(
  providerModels: readonly string[],
  settings: UserSettings,
  discoveryError?: string,
): ProviderModelCatalog {
  const supported = [...new Set(providerModels.filter((model) => typeof model === "string" && model.trim()))];
  const unverifiedModels = settings.customModels.filter((model) => !supported.includes(model));
  const error = supported.length
    ? undefined
    : (discoveryError ??
      "The Provider advertised no supported models. Reconnect the Provider or repair its Local Session.");
  const defaultModel =
    settings.defaultModel && supported.includes(settings.defaultModel) ? settings.defaultModel : supported[0];
  return { models: supported, unverifiedModels, defaultModel, error };
}

function migrateLegacySettings(value: Record<string, unknown>): UserSettings {
  const legacyModels = stringList(value.models ?? []);
  return normalizeSettings({
    version: 1,
    provider: value.provider,
    customModels: legacyModels,
    defaultModel: value.defaultModel,
    codexPath: value.codexPath,
    claudePath: value.claudePath,
    versionChecks: value.versionChecks,
    textScale: value.textScale,
    transcriptDensity: value.transcriptDensity,
  });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("customModels must be an array of non-empty strings");
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
