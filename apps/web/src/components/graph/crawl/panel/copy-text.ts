// Text onto the clipboard from a press. The async clipboard API where the page
// may use it; else the old copy command, which is what is left on a page
// served over plain http — a self-hosted instance on a home network — where
// the API does not exist. False when neither took: the caller then shows the
// text selected, for the person to copy themselves.

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // refused (no focus, a permission policy): the old way may still work
  }
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  try {
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.pointerEvents = 'none';
    document.body.appendChild(area);
    area.select();
    // iOS Safari selects nothing with select() alone.
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    focused?.focus({ preventScroll: true });
  }
}
