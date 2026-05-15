'use client';

import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { useEffect, useRef } from 'react';

export interface NoteEditorProps {
  value: string;
  onChange(value: string): void;
}

/** Minimal CodeMirror 6 markdown editor. Wikilink/autocomplete extensions
 * land in Fase 4.1. */
export function NoteEditor({ value, onChange }: NoteEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        markdown(),
        oneDark,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'transparent' },
          '.cm-content': { padding: '16px', fontFamily: 'var(--font-mono)' },
          '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--border-subtle)' },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // We intentionally do not depend on `value` so editing isn't reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external changes (e.g. switching notes).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  return <div ref={hostRef} className="h-full w-full overflow-auto" />;
}
