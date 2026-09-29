import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';

import { noteSanitizeSchema } from './markdown-sanitize';
import { remarkWikilinks } from './remark-wikilinks';

// The preview's own pipeline, minus the component overrides and highlighting.
function render(body: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkWikilinks],
        rehypePlugins: [rehypeRaw, [rehypeSanitize, noteSanitizeSchema]],
        urlTransform: (url: string) =>
          url.startsWith('wikilink://') || url.startsWith('embed://')
            ? url
            : defaultUrlTransform(url),
      },
      body,
    ),
  );
}

describe('noteSanitizeSchema', () => {
  it('drops event handlers from raw HTML', () => {
    const html = render('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert');
  });

  it('drops script and style elements', () => {
    const html = render('<script>alert(1)</script><style>body{}</style>text');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<style');
  });

  it('drops javascript: URLs', () => {
    expect(render('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
    expect(render('[x](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('drops iframes', () => {
    expect(render('<iframe src="https://example.com"></iframe>')).not.toContain('<iframe');
  });

  // The payload that got through before: React ignores a string `onerror`, but
  // an srcdoc iframe is same-origin and runs its script with the reader's session.
  it('drops srcdoc iframes', () => {
    const html = render('<iframe srcdoc="<script>parent.fetch(\'/api\')</script>"></iframe>');
    expect(html).not.toContain('<iframe');
    expect(html.toLowerCase()).not.toContain('srcdoc');
  });

  it('keeps wikilinks and embeds', () => {
    // Spaces arrive percent-encoded, as they did before sanitising; the `a` override decodes them.
    expect(render('see [[Some Note|alias]]')).toContain('href="wikilink://Some%20Note"');
    expect(render('![[diagram.png]]')).toContain('src="embed://diagram.png"');
  });

  it('keeps the HTML people write in notes', () => {
    const html = render('<details><summary>More</summary><kbd>Ctrl</kbd> H<sub>2</sub>O</details>');
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('<kbd>Ctrl</kbd>');
    expect(html).toContain('<sub>2</sub>');
  });

  it('keeps the language class highlighting reads', () => {
    expect(render('```ts\nconst a = 1;\n```')).toContain('class="language-ts"');
  });

  it('keeps footnote links pointing at their footnotes', () => {
    const html = render('Claim.[^1]\n\n[^1]: Source.');
    const href = /href="#([^"]+)"/.exec(html)?.[1];
    expect(href).toBeDefined();
    expect(html).toContain(`id="${href}"`);
  });

  it('keeps anchors written by hand', () => {
    expect(render('<a id="top"></a>')).toContain('id="top"');
  });

  it('keeps GFM task lists', () => {
    expect(render('- [x] done')).toContain('type="checkbox"');
  });
});
