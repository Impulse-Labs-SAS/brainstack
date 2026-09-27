'use client';

export default function NotesPage() {
  // The tree is drawn by the layout. With no note picked, a phone shows the
  // tree and nothing else: the message would take the whole screen to say nothing.
  return (
    <div className="hidden flex-1 flex-col items-center justify-center gap-1 text-center md:flex">
      <div className="text-sm text-fg-secondary">Pick a note on the left</div>
      <div className="text-xs text-fg-muted">
        or press Ctrl/⌘ K to jump to one, or right-click the tree to create one.
      </div>
    </div>
  );
}
