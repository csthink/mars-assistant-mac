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
