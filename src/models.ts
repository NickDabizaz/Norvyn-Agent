import { loadUserSettings, providerModelCatalog, type ProviderModelCatalog } from "./settings.js";

export async function loadModelCatalog(availableModels: readonly string[]): Promise<ProviderModelCatalog> {
  const { settings } = await loadUserSettings();
  return providerModelCatalog(availableModels, settings);
}
