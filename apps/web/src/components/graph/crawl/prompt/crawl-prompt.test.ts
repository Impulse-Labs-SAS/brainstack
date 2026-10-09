import * as React from 'react';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CrawlPrompt } from './crawl-prompt';
import type { PromptRecent } from './recents';

// The app compiles its JSX itself (tsconfig's `jsx: preserve`); under Vitest
// esbuild falls back to the classic runtime, which calls a global React.
(globalThis as { React?: typeof React }).React = React;

const RECENT: PromptRecent = {
  id: 'r1',
  prompt: 'What links the two plans?',
  meta: 'You · 2 min. ago · 4 notes',
  fresh: false,
};

function render(recents: readonly PromptRecent[]): string {
  return renderToStaticMarkup(
    createElement(CrawlPrompt, {
      boxRef: createRef<HTMLDivElement>(),
      recents,
      shown: true,
      interactive: true,
      focusKey: 0,
      onSubmit: () => {},
      onRecent: () => {},
    }),
  );
}

/** The opening tag of the element whose class list holds `token`. */
function tagWith(html: string, token: string): string {
  const tags = html.match(/<[a-z]+\b[^>]*>/g) ?? [];
  const found = tags.find((t) => / class="([^"]*)"/.exec(t)?.[1]!.split(' ').includes(token));
  expect(found).toBeDefined();
  return found!;
}

describe('CrawlPrompt', () => {
  it('starts its recents below the frame the stage reaches under the box, out of the form’s flow', () => {
    const html = render([RECENT]);
    const recents = tagWith(html, 'top-full');
    expect(recents).toContain('absolute');
    expect(recents).toContain('margin-top:calc(var(--crawl-frame-below, 0px) + 1rem)');
    expect(recents).not.toContain('mt-4');
    expect(html).toContain('What links the two plans?');
    // The box the frame is fitted to keeps no margin and never reads the variable: nothing feeds back.
    const box = tagWith(html, 'h-14');
    expect(box).not.toMatch(/\bm[tblrxy]?-\d|margin/);
    expect(box).not.toContain('--crawl-frame-below');
  });

  it('holds its recents to the room left under the frame, scrolling there, never past the stage', () => {
    const html = render([RECENT, { ...RECENT, id: 'r2' }, { ...RECENT, id: 'r3' }]);
    // The overlay, sized by the stage and not by what it holds, is what they measure.
    const overlay = tagWith(html, 'place-items-center');
    expect(overlay).toContain('inset-0');
    expect(overlay).toContain('container-type:size');
    const recents = tagWith(html, 'top-full');
    expect(/ class="([^"]*)"/.exec(recents)![1]!.split(' ')).toContain('overflow-y-auto');
    // Half the overlay, less half the box, the gap under the frame and one above the bottom.
    expect(recents).toContain(
      'max-height:max(0px, calc(50cqh - 1.75rem - calc(var(--crawl-frame-below, 0px) + 1rem) - 1rem))',
    );
  });

  it('has no recents block without recents', () => {
    const html = render([]);
    expect(html).not.toContain('top-full');
    expect(html).not.toContain('--crawl-frame-below');
  });
});
