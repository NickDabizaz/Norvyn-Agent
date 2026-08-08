export function clampPaneWidth(requested: number, total: number): number {
  return Math.min(Math.max(requested, 220), Math.max(220, total - 420));
}

export function storedNumber(key: string): number | undefined {
  if (typeof sessionStorage === "undefined") return undefined;
  const value = Number(sessionStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function storedSession(key: string): string | null {
  return typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(key);
}

export function downloadText(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
