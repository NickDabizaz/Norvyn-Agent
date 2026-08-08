export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const prefix = "norvyn.draft.";

export function loadDraft(storage: DraftStorage, chatId: string): string {
  return storage.getItem(`${prefix}${chatId}`) ?? "";
}

export function saveDraft(storage: DraftStorage, chatId: string, value: string): void {
  if (value) storage.setItem(`${prefix}${chatId}`, value);
  else storage.removeItem(`${prefix}${chatId}`);
}

export function discardDraft(storage: DraftStorage, chatId: string): void {
  storage.removeItem(`${prefix}${chatId}`);
}

export function isNorvynDraftKey(key: string): boolean {
  return key.startsWith(prefix);
}
