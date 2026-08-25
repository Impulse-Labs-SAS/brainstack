'use client';

import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { useEffect, useRef } from 'react';

/** Sober markdown highlight aligned with the app palette (no saturated greens/reds). */
const brainHighlight = HighlightStyle.define([
  { tag: t.heading1, color: 'var(--fg-primary)', fontWeight: '600' },
  { tag: t.heading2, color: 'var(--fg-primary)', fontWeight: '600' },
  {
    tag: [t.heading3, t.heading4, t.heading5, t.heading6],
    color: 'var(--fg-primary)',
    fontWeight: '600',
  },
  { tag: t.strong, color: 'var(--fg-primary)', fontWeight: '600' },
  { tag: t.emphasis, color: 'var(--fg-primary)', fontStyle: 'italic' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--accent)' },
  { tag: t.monospace, color: 'var(--fg-secondary)' },
  { tag: t.quote, color: 'var(--fg-secondary)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--fg-secondary)' },
  { tag: t.meta, color: 'var(--fg-muted)' },
  { tag: t.comment, color: 'var(--fg-muted)', fontStyle: 'italic' },
  { tag: t.processingInstruction, color: 'var(--fg-muted)' },
  { tag: t.contentSeparator, color: 'var(--fg-muted)' },
  { tag: [t.atom, t.bool, t.number], color: 'var(--fg-secondary)' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: 'var(--fg-secondary)' },
  { tag: [t.string, t.regexp], color: 'var(--fg-secondary)' },
  { tag: t.escape, color: 'var(--accent)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

export interface NoteEditorProps {
  value: string;
  onChange?(value: string): void;
  readOnly?: boolean;
}

/** Minimal CodeMirror 6 markdown editor. Wikilink/autocomplete extensions
 * land in Fase 4.1. */
export function NoteEditor({ value, onChange, readOnly = false }: NoteEditorProps) {
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
        syntaxHighlighting(brainHighlight),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        ...(readOnly ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
        EditorView.theme(
          {
            '&': {
              height: '100%',
              backgroundColor: 'transparent',
              color: 'var(--fg-primary)',
            },
            '.cm-scroller': { fontFamily: 'var(--font-mono)' },
            '.cm-content': { padding: '16px', caretColor: 'var(--accent)' },
            '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
            '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
              backgroundColor: 'rgba(124, 92, 255, 0.25)',
            },
            '.cm-gutters': {
              backgroundColor: 'transparent',
              borderRight: '1px solid var(--border-subtle)',
              color: 'var(--fg-muted)',
            },
            '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.02)' },
            '.cm-activeLineGutter': {
              backgroundColor: 'transparent',
              color: 'var(--fg-secondary)',
            },
            '.cm-lineNumbers .cm-gutterElement': { color: 'var(--fg-disabled)' },
          },
          { dark: true },
        ),
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
