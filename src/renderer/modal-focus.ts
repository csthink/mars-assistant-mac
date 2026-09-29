/** Restore the invoker and its pre-dialog focus indication together. */
export function openModal(dialog: HTMLDialogElement) {
  const previous = document.activeElement;
  const options = {
    preventScroll: true,
    focusVisible: previous?.matches(":focus-visible") ?? false,
  };
  dialog.showModal();
  return () => {
    dialog.close();
    if (!(previous instanceof HTMLElement) || !previous.isConnected) return;
    // Native dialog close may already have focused the invoker. Chromium only
    // applies focusVisible when focus actually moves, so reapply it explicitly.
    if (document.activeElement === previous) previous.blur();
    previous.focus(options);
  };
}

/**
 * Focuses an entry again, with a focus ring only when it was reached by keyboard (Chromium's focusVisible).
 * Chromium applies focusVisible only when focus actually moves, so an entry that already holds focus is
 * blurred first.
 */
export function refocus(
  element: HTMLElement | null | undefined,
  visible: boolean,
) {
  if (!element) return;
  const options = { preventScroll: true, focusVisible: visible };
  if (document.activeElement === element) element.blur();
  element.focus(options);
}

/**
 * Refocuses an entry once it is on the page. The element that held focus (an inline field) goes away in the
 * same update that brings the entry back; a discrete event's update is committed before its microtasks run,
 * so the first attempt is a microtask (focus never rests on the page body in between), then a few frames.
 */
export function refocusWhenReady(
  find: () => HTMLElement | null | undefined,
  visible: boolean,
  frames = 10,
) {
  const attempt = (left: number) => {
    const element = find();
    if (element) refocus(element, visible);
    else if (left > 0) requestAnimationFrame(() => attempt(left - 1));
  };
  queueMicrotask(() => {
    const element = find();
    if (element) refocus(element, visible);
    else requestAnimationFrame(() => attempt(frames));
  });
}
