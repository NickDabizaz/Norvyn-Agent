import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;

export interface ModelCatalog { models: string[]; defaultModel: string }

export async function loadModelCatalog(availableModels: readonly string[] = DEFAULT_MODELS): Promise<ModelCatalog> {
  const path = process.env.NORVYN_CONFIG ?? join(homedir(), ".norvyn", "config.json");
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults(availableModels);
    throw error;
  }

  try {
    const config = JSON.parse(raw) as { models?: unknown; modelMode?: unknown; defaultModel?: unknown };
    if (config.models !== undefined && (!Array.isArray(config.models) || config.models.some((model) => typeof model !== "string" || !model.trim()))) {
      throw new Error("'models' must be an array of non-empty strings");
    }
    if (config.modelMode !== undefined && config.modelMode !== "add" && config.modelMode !== "replace") {
      throw new Error("'modelMode' must be 'add' or 'replace'");
    }
    if (config.defaultModel !== undefined && typeof config.defaultModel !== "string") throw new Error("'defaultModel' must be a string");
    const configured = (config.models ?? []) as string[];
    const models = config.modelMode === "replace" ? configured : [...new Set([...availableModels, ...configured])];
    if (models.length === 0) throw new Error("the model list cannot be empty");
    const defaultModel = (config.defaultModel as string | undefined) ?? models[0];
    if (!models.includes(defaultModel)) throw new Error("'defaultModel' must occur in the model list");
    return { models, defaultModel };
  } catch (error) {
    throw new Error(`Malformed Norvyn config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function defaults(availableModels: readonly string[]): ModelCatalog {
  const models = [...new Set(availableModels)];
  if (!models.length) return { models: [...DEFAULT_MODELS], defaultModel: DEFAULT_MODELS[0] };
  return { models, defaultModel: models[0] };
}
