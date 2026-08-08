export function autosizeComposer(input: HTMLTextAreaElement | null): void {
  if (!input) return;
  input.style.height = "auto";
  input.style.overflowY = "hidden";
  input.style.height = `${input.scrollHeight}px`;
  if (input.scrollHeight > input.clientHeight) input.style.overflowY = "auto";
}

export function shouldSubmitComposer(key: string, shiftKey: boolean, isComposing: boolean): boolean {
  return key === "Enter" && !shiftKey && !isComposing;
}
