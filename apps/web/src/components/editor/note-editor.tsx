'use client';

// The note editor. It edits markdown, but reads like the document it will
// become: prose in the sans face on a ~72-character column, headings at their
// size, markdown syntax dimmed, the frontmatter shown as Properties and
// wikilinks shown as links. Monospace is kept for code.

import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { completionKeymap } from '@codemirror/autocomplete';
import { useEffect, useRef } from 'react';

import type { WikilinkCandidate } from '@/lib/wikilink-autocomplete-match';

import { propertiesExtension, setProperties } from './properties-extension';
import { wikilinkAutocomplete } from './wikilink-autocomplete';
import { wikilinkMarks } from './wikilink-marks';

/** Sober markdown highlight aligned with the app palette (no saturated greens/reds). */
const brainHighlight = HighlightStyle.define([
  { tag: t.heading1, color: 'var(--fg-primary)', fontWeight: '600', fontSize: '1.75em', letterSpacing: '-0.02em' },
  { tag: t.heading2, color: 'var(--fg-primary)', fontWeight: '600', fontSize: '1.3em' },
  { tag: t.heading3, color: 'var(--fg-primary)', fontWeight: '600', fontSize: '1.1em' },
  { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--fg-primary)', fontWeight: '600' },
  { tag: t.strong, color: 'var(--fg-primary)', fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--accent-hover)' },
  { tag: t.url, color: 'var(--fg-muted)' },
  { tag: t.monospace, color: '#c9c2ff', fontFamily: 'var(--font-mono)', fontSize: '0.88em' },
  { tag: t.quote, color: 'var(--fg-secondary)', fontStyle: 'italic' },
  { tag: t.meta, color: 'var(--fg-muted)' },
  { tag: t.comment, color: 'var(--fg-muted)', fontStyle: 'italic' },
  // Markdown's own marks — `#`, `**`, `>`, backticks — step back so the text leads.
  { tag: t.processingInstruction, color: 'var(--fg-disabled)', fontWeight: '400' },
  { tag: t.contentSeparator, color: 'var(--fg-muted)' },
  { tag: [t.atom, t.bool, t.number], color: 'var(--fg-secondary)' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: 'var(--fg-secondary)' },
  { tag: [t.string, t.regexp], color: 'var(--fg-secondary)' },
  { tag: t.escape, color: 'var(--accent)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

const theme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'transparent',
      color: 'var(--fg-body)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-sans)', fontSize: '15px', lineHeight: '1.75' },
    '.cm-content': {
      maxWidth: 'calc(72ch + 48px)',
      margin: '0 auto',
      padding: '32px 24px 120px',
      caretColor: 'var(--accent)',
    },
    '.cm-line': { padding: '0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(124, 92, 255, 0.25)',
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-md-mark': { color: 'var(--fg-disabled)' },
    '.cm-wikilink-target': { color: 'var(--fg-muted)' },
    '.cm-wikilink': {
      color: 'var(--accent-hover)',
      textDecoration: 'underline',
      textDecorationColor: 'rgba(149, 121, 255, 0.4)',
      textUnderlineOffset: '3px',
    },
    '.cm-properties-raw': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
      color: 'var(--fg-muted)',
      padding: '4px 0',
      borderBottom: '1px solid var(--border-subtle)',
      marginBottom: '6px',
    },
    '.cm-properties-raw button': {
      fontFamily: 'var(--font-sans)',
      fontSize: '12px',
      color: 'var(--fg-primary)',
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-default)',
      borderRadius: '6px',
      padding: '1px 8px',
      cursor: 'pointer',
    },
    '.cm-tooltip.cm-tooltip-autocomplete': {
      backgroundColor: 'var(--bg-elevated)',
      border: '1px solid var(--border-default)',
      borderRadius: '8px',
      fontFamily: 'var(--font-sans)',
      fontSize: '13px',
      overflow: 'hidden',
    },
    '.cm-tooltip-autocomplete ul li': { color: 'var(--fg-secondary)', padding: '3px 8px' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--bg-hover)',
      color: 'var(--fg-primary)',
    },
    '.cm-completionDetail': {
      color: 'var(--fg-muted)',
      fontStyle: 'normal',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
    },
  },
  { dark: true },
);

export interface NoteEditorProps {
  value: string;
  onChange?(value: string): void;
  readOnly?: boolean;
  /**
   * Notes `[[` can autocomplete to. A function, not a plain array, so the
   * editor sees a freshly-fetched list on every completion even though it
   * mounts once — the tree changes as notes are created while it stays open.
   */
  wikilinkCandidates?: () => readonly WikilinkCandidate[];
  /** The frontmatter as the server parsed it, shown as the Properties block. */
  frontmatter?: Record<string, unknown>;
  /** Follows a route from inside the editor (a property chip). */
  onNavigate?(href: string): void;
  /** Follows a wikilink, on Ctrl/⌘-click. */
  onOpenLink?(target: string): void;
  /** The view, for callers that scroll or move the cursor (the outline). */
  onReady?(view: EditorView | null): void;
}

/** CodeMirror 6 markdown editor, with `[[` wikilink autocomplete. */
export function NoteEditor({
  value,
  onChange,
  readOnly = false,
  wikilinkCandidates,
  frontmatter,
  onNavigate,
  onOpenLink,
  onReady,
}: NoteEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const candidatesRef = useRef(wikilinkCandidates);
  candidatesRef.current = wikilinkCandidates;
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const openLinkRef = useRef(onOpenLink);
  openLinkRef.current = onOpenLink;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const frontmatterRef = useRef(frontmatter);
  frontmatterRef.current = frontmatter;

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        markdown(),
        syntaxHighlighting(brainHighlight),
        propertiesExtension(
          (href) => navigateRef.current?.(href),
          frontmatterRef.current ?? {},
        ),
        wikilinkMarks((target) => openLinkRef.current?.(target)),
        ...(candidatesRef.current
          ? [wikilinkAutocomplete(() => candidatesRef.current?.() ?? [])]
          : []),
        keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Note text', spellcheck: 'true' }),
        ...(readOnly ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
        theme,
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    readyRef.current?.(view);
    return () => {
      readyRef.current?.(null);
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

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setProperties.of(frontmatter ?? {}) });
  }, [frontmatter]);

  return <div ref={hostRef} className="h-full w-full overflow-auto" />;
}
