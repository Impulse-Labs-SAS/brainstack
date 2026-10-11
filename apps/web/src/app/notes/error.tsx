'use client';

// One note that fails to render takes down this pane, not the app: the tree
// stays, so the reader can open another note or switch the view mode.

import { Button } from '@/components/ui/button';

export default function NoteError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
      <p className="text-fg-primary">This note could not be shown.</p>
      <p className="max-w-md text-center text-xs text-fg-muted">
        Something in it broke the view. Open another note from the tree, or try again; switching
        to Edit shows the text as written.
      </p>
      {error.message && <p className="font-mono text-[11px] text-fg-muted">{error.message}</p>}
      <Button size="sm" onPress={reset}>
        Try again
      </Button>
    </div>
  );
}
