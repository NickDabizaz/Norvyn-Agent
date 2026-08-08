import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

interface AnchorSnapshot {
  chatKey?: string;
  atEnd: boolean;
  entryId?: string;
  offset?: number;
}

export function useTranscriptScrollAnchor(
  chatKey: string | undefined,
  revision: string,
): RefObject<HTMLDivElement | null> {
  const container = useRef<HTMLDivElement>(null);
  const snapshot = useRef<AnchorSnapshot>({ atEnd: true });

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const capture = () => captureSnapshot(element, chatKey, snapshot);
    element.addEventListener("scroll", capture, { passive: true });
    capture();
    return () => element.removeEventListener("scroll", capture);
  }, [chatKey]);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const previous = snapshot.current;
    if (previous.chatKey !== chatKey || previous.atEnd) {
      element.scrollTop = element.scrollHeight;
    } else if (previous.entryId && previous.offset !== undefined) {
      const anchor = [...element.querySelectorAll<HTMLElement>("[data-transcript-entry]")].find(
        (entry) => entry.dataset.transcriptEntry === previous.entryId,
      );
      if (anchor) {
        const nextOffset = anchor.getBoundingClientRect().top - element.getBoundingClientRect().top;
        element.scrollTop += nextOffset - previous.offset;
      }
    }
    captureSnapshot(element, chatKey, snapshot);
  }, [chatKey, revision]);

  return container;
}

export function transcriptScrollRevision(
  entries: readonly { id: string; kind: string; text?: string; output?: string; status?: string }[],
): string {
  return entries
    .map(
      (entry) =>
        `${entry.id}:${entry.kind}:${entry.text?.length ?? 0}:${entry.output?.length ?? 0}:${entry.status ?? ""}`,
    )
    .join("|");
}

function captureSnapshot(
  element: HTMLElement,
  chatKey: string | undefined,
  snapshot: { current: AnchorSnapshot },
): void {
  const bounds = element.getBoundingClientRect();
  const entries = [...element.querySelectorAll<HTMLElement>("[data-transcript-entry]")];
  const anchor = entries.find((entry) => entry.getBoundingClientRect().bottom > bounds.top);
  snapshot.current = {
    chatKey,
    atEnd: element.scrollHeight - element.scrollTop - element.clientHeight <= 24,
    entryId: anchor?.dataset.transcriptEntry,
    offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : undefined,
  };
}
