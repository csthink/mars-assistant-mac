import { useEffect, useRef } from "react";

/** Configuration results must be visible even when the model list is long. */
export function useNativeSetupFeedback(error: string, setup: unknown) {
  const errorRef = useRef<HTMLParagraphElement>(null);
  const setupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = error ? errorRef.current : setup ? setupRef.current : null;
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [error, setup]);
  return { errorRef, setupRef };
}
