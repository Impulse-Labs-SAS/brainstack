// remark plugin that rewrites Obsidian-style wikilinks ([[target]],
// [[target|alias]], ![[target]]) into mdast `link`/`image` nodes whose
// `url` carries a custom scheme. The Markdown renderer's `components`
// override then decides how to render them (internal Next link, attachment
// embed, etc.) — keeping the resolution logic outside the plugin.

import { visit, SKIP } from 'unist-util-visit';

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  children?: MdNode[];
}
type TextNode = MdNode & { type: 'text'; value: string };
type LinkNode = MdNode & { type: 'link'; url: string; children: MdNode[] };
type ImageNode = MdNode & { type: 'image'; url: string; alt: string };
type ParentNode = MdNode & { children: MdNode[] };

const WIKILINK_RE = /(!)?\[\[([^\]\n]+?)\]\]/g;

interface WikilinkPiece {
  type: 'text' | 'link' | 'image';
  value: string;
  target?: string;
  alias?: string;
}

function splitWikilinks(value: string): WikilinkPiece[] {
  const pieces: WikilinkPiece[] = [];
  let last = 0;
  for (const match of value.matchAll(WIKILINK_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) {
      pieces.push({ type: 'text', value: value.slice(last, idx) });
    }
    const isEmbed = match[1] === '!';
    const inner = (match[2] ?? '').trim();
    if (!inner) {
      pieces.push({ type: 'text', value: match[0] });
      last = idx + match[0].length;
      continue;
    }
    const pipe = inner.indexOf('|');
    const target = pipe === -1 ? inner : inner.slice(0, pipe).trim();
    const alias = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
    pieces.push({
      type: isEmbed ? 'image' : 'link',
      value: match[0],
      target,
      alias,
    });
    last = idx + match[0].length;
  }
  if (last < value.length) {
    pieces.push({ type: 'text', value: value.slice(last) });
  }
  return pieces;
}

export function remarkWikilinks() {
  return (tree: unknown) => {
    visit(tree as never, 'text', (node: unknown, index, parent: unknown) => {
      const textNode = node as TextNode;
      const parentNode = parent as ParentNode | undefined;
      if (!parentNode || typeof index !== 'number') return;
      if (parentNode.type === 'code' || parentNode.type === 'inlineCode') return SKIP;
      const value = textNode.value;
      if (!value.includes('[[')) return;
      const pieces = splitWikilinks(value);
      if (pieces.length === 1 && pieces[0]!.type === 'text') return;
      const replacement = pieces.map((p) => pieceToNode(p));
      parentNode.children.splice(index, 1, ...replacement);
      return [SKIP, index + replacement.length];
    });
  };
}

function pieceToNode(p: WikilinkPiece): TextNode | LinkNode | ImageNode {
  if (p.type === 'text') return { type: 'text', value: p.value };
  if (p.type === 'image') {
    return {
      type: 'image',
      url: `embed://${p.target}`,
      alt: p.alias ?? p.target ?? '',
    };
  }
  return {
    type: 'link',
    url: `wikilink://${p.target}`,
    children: [{ type: 'text', value: p.alias ?? p.target ?? '' }],
  };
}
