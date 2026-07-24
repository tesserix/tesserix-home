"use client";

import { useEffect } from "react";

/**
 * Run `callback` every `delayMs` while the document is visible.
 * Pauses when the tab is hidden and refires immediately on return.
 * Skips entirely when delayMs is null or callback is null.
 *
 * Callers should memoize `callback` with `useCallback` to avoid
 * re-installing the interval on every render.
 */
export function useVisibilityInterval(
  callback: (() => void) | null,
  delayMs: number | null,
): void {
  useEffect(() => {
    if (callback === null || delayMs === null) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (timer !== null || callback === null) return;
      timer = setInterval(callback, delayMs as number);
    }

    function stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        callback?.();
        start();
      } else {
        stop();
      }
    }

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [delayMs, callback]);
}
