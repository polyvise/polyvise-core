"use client";

/**
 * SlowPrint — reveals a string one character at a time at a configurable
 * speed, then emits a callback when typing completes. Used by the
 * /froglings funner UI so kids can read each frog's argument at a
 * comfortable pace, and so the frog's mouth animation (and Phase 6's
 * frog-chirp audio) can be synced to "is this frog currently speaking?".
 *
 * Behavior:
 *   - When `text` changes, the print resets and starts over.
 *   - `charsPerTick` controls speed (default 1).
 *   - `tickMs` controls tick cadence (default 28ms — roughly 35 chars/sec
 *     at the default speed, which is fast enough to keep adults from
 *     getting impatient but slow enough that a 7-year-old can read along).
 *   - `onTypingChange` fires with `true` when printing begins and `false`
 *     when it finishes (or when an empty string is passed).
 *   - Honors `prefers-reduced-motion`: instant print when set.
 */

import { useEffect, useRef, useState } from "react";

interface SlowPrintProps {
  text: string;
  charsPerTick?: number;
  tickMs?: number;
  /** Receives true while printing, false once complete (or on empty text). */
  onTypingChange?: (typing: boolean) => void;
  /** Fires once when the current text has fully printed. */
  onComplete?: () => void;
  className?: string;
}

export function SlowPrint({
  text,
  charsPerTick = 1,
  tickMs = 28,
  onTypingChange,
  onComplete,
  className
}: SlowPrintProps) {
  const [shown, setShown] = useState("");
  // Latest typing-state callback, captured so the effect doesn't restart
  // whenever the parent passes a new closure.
  const onTypingRef = useRef(onTypingChange);
  onTypingRef.current = onTypingChange;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (!text) {
      setShown("");
      onTypingRef.current?.(false);
      return;
    }

    // Respect reduced-motion preference: skip the animation entirely.
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setShown(text);
      onTypingRef.current?.(false);
      onCompleteRef.current?.();
      return;
    }

    setShown("");
    onTypingRef.current?.(true);
    let cancelled = false;
    let cursor = 0;
    const step = Math.max(1, Math.floor(charsPerTick));

    const interval = window.setInterval(() => {
      if (cancelled) return;
      cursor = Math.min(text.length, cursor + step);
      setShown(text.slice(0, cursor));
      if (cursor >= text.length) {
        window.clearInterval(interval);
        onTypingRef.current?.(false);
        onCompleteRef.current?.();
      }
    }, tickMs);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      // If we get unmounted mid-print, tell the parent we're no longer
      // "speaking" so the mouth animation / audio stop.
      onTypingRef.current?.(false);
    };
    // We intentionally do not depend on the callback; ref keeps it fresh
    // without restarting the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, charsPerTick, tickMs]);

  return <span className={className}>{shown}</span>;
}
