import type { TurnAttachment } from "../protocol.js";

export const maximumAttachments = 10;
const maximumImageBytes = 10 * 1024 * 1024;
const maximumTextBytes = 1024 * 1024;

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

export async function readComposerFiles(
  files: Iterable<File>,
  remaining: number,
): Promise<{ attachments: TurnAttachment[]; rejected: string[] }> {
  const attachments: TurnAttachment[] = [];
  const rejected: string[] = [];
  for (const file of [...files].slice(0, Math.max(0, remaining))) {
    if (file.type.startsWith("image/")) {
      if (file.size > maximumImageBytes) {
        rejected.push(`${file.name} is larger than 10 MB.`);
        continue;
      }
      attachments.push({
        kind: "image",
        name: file.name,
        mimeType: file.type,
        dataUrl: await readFile(file, "data-url"),
      });
      continue;
    }
    if (isTextFile(file)) {
      if (file.size > maximumTextBytes) {
        rejected.push(`${file.name} is larger than 1 MB.`);
        continue;
      }
      attachments.push({
        kind: "text",
        name: file.name,
        mimeType: file.type || "text/plain",
        text: await readFile(file, "text"),
      });
      continue;
    }
    rejected.push(`${file.name} is not a supported image or text file.`);
  }
  if ([...files].length > remaining) rejected.push(`A Turn can include at most ${maximumAttachments} files.`);
  return { attachments, rejected };
}

function isTextFile(file: File): boolean {
  return (
    file.type.startsWith("text/") ||
    /\.(?:csv|css|html?|jsx?|json|log|md|toml|tsx?|xml|ya?ml)$/i.test(file.name)
  );
}

function readFile(file: File, mode: "data-url" | "text"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result ?? ""));
    if (mode === "data-url") reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}
