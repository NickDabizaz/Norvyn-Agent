export const TRANSCRIPT_WINDOW_SIZE = 200;

export function visibleTranscript<T>(entries: readonly T[], limit = TRANSCRIPT_WINDOW_SIZE): readonly T[] {
  return entries.length <= limit ? entries : entries.slice(entries.length - limit);
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  const boundedAttempt = Math.min(Math.max(attempt, 0), 6);
  const base = Math.min(10_000, 250 * 2 ** boundedAttempt);
  return Math.round(base * (0.8 + random() * 0.4));
}
