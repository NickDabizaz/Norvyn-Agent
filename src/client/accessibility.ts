import { useEffect, useRef, type RefObject } from "react";

const focusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useModalFocus(
  open: boolean,
  container: RefObject<HTMLElement | null>,
  initial: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  const previousFocus = useRef<HTMLElement | undefined>(undefined);
  const closeRef = useRef(close);

  useEffect(() => {
    closeRef.current = close;
  }, [close]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    queueMicrotask(() => initial.current?.focus());

    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !container.current) return;
      const focusable = [...container.current.querySelectorAll<HTMLElement>(focusableSelector)];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previousFocus.current?.focus();
    };
  }, [container, initial, open]);
}

export function moveMenuFocus(container: HTMLElement, current: HTMLElement, key: string): boolean {
  const options = [...container.querySelectorAll<HTMLElement>('[role="option"], [data-menu-option]')];
  if (!options.length) return false;
  const currentIndex = Math.max(0, options.indexOf(current));
  const nextIndex =
    key === "Home"
      ? 0
      : key === "End"
        ? options.length - 1
        : key === "ArrowDown"
          ? (currentIndex + 1) % options.length
          : key === "ArrowUp"
            ? (currentIndex - 1 + options.length) % options.length
            : -1;
  if (nextIndex < 0) return false;
  options[nextIndex].focus();
  return true;
}
