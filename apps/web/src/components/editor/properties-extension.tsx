'use client';

// Shows a note's frontmatter in the editor as the Properties block rather
// than as YAML. The YAML stays in the document — it is what gets saved — and
// "Edit as YAML" reveals it for editing; "Done" folds it back.
//
// What the block shows comes from the server's parse of the saved note
// (`setProperties`), not from re-parsing YAML here: while the raw text is
// being edited the block is not on screen, and after the autosave the server
// hands back the new values.

import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { createRoot, type Root } from 'react-dom/client';

import {
  PropertiesBlock,
  readPropertiesOpen,
  writePropertiesOpen,
} from '@/components/note/properties-block';

export const setProperties = StateEffect.define<Record<string, unknown>>();
const setRaw = StateEffect.define<boolean>();

interface PropsState {
  frontmatter: Record<string, unknown>;
  raw: boolean;
}

/** Where the frontmatter block ends: just past its closing `---` line. */
export function frontmatterEnd(state: EditorState): number | null {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text !== '---') return null;
  for (let n = 2; n <= doc.lines; n++) {
    if (doc.line(n).text === '---') return doc.line(n).to;
  }
  return null;
}

type Navigate = (href: string) => void;

class PropertiesWidget extends WidgetType {
  private root: Root | null = null;

  constructor(
    readonly frontmatter: Record<string, unknown>,
    readonly navigate: Navigate,
  ) {
    super();
  }

  override eq(other: PropertiesWidget): boolean {
    return JSON.stringify(other.frontmatter) === JSON.stringify(this.frontmatter);
  }

  override toDOM(view: EditorView): HTMLElement {
    const host = document.createElement('div');
    host.className = 'cm-properties';
    // Clicks inside the block are the block's, not the editor's selection.
    host.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root = createRoot(host);
    const render = (open: boolean) => {
      this.root?.render(
        <PropertiesBlock
          frontmatter={this.frontmatter}
          open={open}
          onToggle={() => {
            writePropertiesOpen(!open);
            render(!open);
          }}
          onNavigate={this.navigate}
          onEditYaml={() => view.dispatch({ effects: setRaw.of(true) })}
          className="mb-5"
        />,
      );
    };
    render(readPropertiesOpen());
    return host;
  }

  override destroy(): void {
    const root = this.root;
    this.root = null;
    // Unmounting while CodeMirror is mid-update makes React warn; a tick later
    // it is a plain cleanup.
    setTimeout(() => root?.unmount(), 0);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class DoneWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-properties-raw';
    const label = document.createElement('span');
    label.textContent = 'Editing properties as YAML';
    const done = document.createElement('button');
    done.type = 'button';
    done.textContent = 'Done';
    done.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ effects: setRaw.of(false) });
    });
    bar.append(label, done);
    return bar;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function decorate(state: EditorState, s: PropsState, navigate: Navigate): DecorationSet {
  const end = frontmatterEnd(state);
  if (end === null) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  // Nothing parsed (a note that was just given YAML, or YAML the server could
  // not read): hiding the text would hide the only copy of it.
  if (!s.raw && Object.keys(s.frontmatter).length === 0) return Decoration.none;
  if (s.raw) {
    ranges.push(Decoration.widget({ widget: new DoneWidget(), block: true, side: -1 }).range(0));
  } else {
    // Covers the line break after `---` too, so no empty line is left behind.
    const to = Math.min(end + 1, state.doc.length);
    ranges.push(
      Decoration.replace({
        widget: new PropertiesWidget(s.frontmatter, navigate),
        block: true,
      }).range(0, to),
    );
  }
  return Decoration.set(ranges);
}

export function propertiesExtension(navigate: Navigate, initial: Record<string, unknown>) {
  const field = StateField.define<{ s: PropsState; deco: DecorationSet }>({
    create(state) {
      const s = { frontmatter: initial, raw: false };
      return { s, deco: decorate(state, s, navigate) };
    },
    update(value, tr) {
      let s = value.s;
      for (const e of tr.effects) {
        if (e.is(setProperties)) s = { ...s, frontmatter: e.value };
        if (e.is(setRaw)) s = { ...s, raw: e.value };
      }
      if (s === value.s && !tr.docChanged) return value;
      return { s, deco: decorate(tr.state, s, navigate) };
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.deco),
      // The cursor steps over the folded block instead of into hidden text.
      EditorView.atomicRanges.of((view) => view.state.field(f).deco),
    ],
  });
  return field;
}
