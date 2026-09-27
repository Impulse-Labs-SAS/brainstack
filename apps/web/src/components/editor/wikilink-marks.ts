// Wikilinks in the editor: `[[target|alias]]` reads as a link, with the
// brackets and the target dimmed when an alias says it better. Ctrl/⌘-click
// follows it; a plain click keeps placing the cursor, as in any editor.

import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

const WIKILINK = /(!?\[\[)([^\]|\n]+?)(\|[^\]\n]*)?(\]\])/g;

const mark = Decoration.mark({ class: 'cm-md-mark' });
const dim = Decoration.mark({ class: 'cm-wikilink-target' });

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    WIKILINK.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK.exec(text))) {
      const start = from + m.index;
      const [, open, target, alias, close] = m as unknown as [string, string, string, string | undefined, string];
      const targetFrom = start + open.length;
      const targetTo = targetFrom + target.length;
      const link = Decoration.mark({
        class: 'cm-wikilink',
        attributes: { 'data-wikilink': target.trim(), title: `${target.trim()} — Ctrl/⌘-click to open` },
      });
      builder.add(start, targetFrom, mark);
      if (alias) {
        builder.add(targetFrom, targetTo + 1, dim);
        builder.add(targetTo + 1, targetTo + alias.length, link);
      } else {
        builder.add(targetFrom, targetTo, link);
      }
      const closeFrom = targetTo + (alias?.length ?? 0);
      builder.add(closeFrom, closeFrom + close.length, mark);
    }
  }
  return builder.finish();
}

export function wikilinkMarks(onOpen: (target: string) => void) {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.domEventHandlers({
      mousedown(e) {
        if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-wikilink]');
        if (!el?.dataset.wikilink) return false;
        e.preventDefault();
        onOpen(el.dataset.wikilink);
        return true;
      },
    }),
  ];
}
