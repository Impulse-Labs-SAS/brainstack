// The plate layout off the main thread: a vault of thousands of notes is laid out
// while the page keeps drawing. It answers every request, in the order they came;
// which answer still matters is the client's to decide.

import { layoutIso, type LayoutNote, type LayoutVault } from './territories';

export interface LayoutRequest {
  notes: readonly LayoutNote[];
  vaults: readonly LayoutVault[];
}

// The app compiles against the DOM's lib, not the worker's: this is all of the
// worker's scope it uses.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { notes, vaults } = event.data;
  const layout = layoutIso(notes, vaults);
  // Moved, not copied. layoutIso allocates both arrays, so their buffers are plain ArrayBuffers.
  scope.postMessage(layout, [
    layout.cells.buffer as ArrayBuffer,
    layout.plateOf.buffer as ArrayBuffer,
  ]);
};
