// Which keys the graph takes, and from where. The canvas is the graph: every key pressed on it
// goes to the controller, which says whether it used it. The preview sheet speaks for the same
// selection, so from anywhere in it Escape closes and Backspace goes back. The arrows and Enter
// walk and open only from its heading, where a pick made from the keyboard leaves focus: on one
// of its buttons Enter is the button's, and an arrow would swap the list out from under the
// person going through it.

import type { PressEvent } from 'react-aria-components';

/** Where on the stage a key was pressed, as far as the graph is concerned. */
export type KeyOrigin = 'canvas' | 'sheet' | 'sheet-heading' | 'elsewhere';

const SHEET_KEYS = new Set(['Escape', 'Backspace']);
const HEADING_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter']);

/** Whether a key pressed at `origin` goes to the graph's controller. */
export function reachesGraph(key: string, origin: KeyOrigin): boolean {
  switch (origin) {
    case 'canvas':
      return true;
    case 'sheet-heading':
      return SHEET_KEYS.has(key) || HEADING_KEYS.has(key);
    case 'sheet':
      return SHEET_KEYS.has(key);
    case 'elsewhere':
      return false;
  }
}

/**
 * A key held with Alt, Ctrl or Meta: the browser's, never the graph's. Alt+Left is Back, Ctrl+-
 * the page's zoom, and both were walking or zooming the graph instead. Shift is not one: it
 * makes the + that zooms in.
 */
export function browserShortcut(e: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey'>): boolean {
  return e.altKey || e.ctrlKey || e.metaKey;
}

/**
 * A press made without a pointer: the keyboard, or a screen reader's virtual click. Focus
 * follows what such a press picks; after a mouse or a finger it stays where it was.
 */
export function withoutPointer(pointerType: PressEvent['pointerType']): boolean {
  return pointerType === 'keyboard' || pointerType === 'virtual';
}
