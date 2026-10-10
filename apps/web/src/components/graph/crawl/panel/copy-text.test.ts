import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyText } from './copy-text';

/** Just enough of a page for the old copy command: a textarea to select, and the command. */
function page(copies: boolean) {
  const area = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const focused = { focus: vi.fn() };
  const doc = {
    activeElement: focused,
    body: { appendChild: vi.fn() },
    createElement: vi.fn(() => area),
    execCommand: vi.fn(() => copies),
  };
  vi.stubGlobal('HTMLElement', Object);
  vi.stubGlobal('document', doc);
  return { area, doc, focused };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyText', () => {
  it('uses the clipboard API where the page has it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { doc } = page(true);
    expect(await copyText('the prompt')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('the prompt');
    expect(doc.execCommand).not.toHaveBeenCalled();
  });

  it('falls back to the copy command where the API is missing, as on plain http, and leaves no trace', async () => {
    vi.stubGlobal('navigator', {});
    const { area, doc, focused } = page(true);
    expect(await copyText('the prompt')).toBe(true);
    expect(area.value).toBe('the prompt');
    expect(area.setSelectionRange).toHaveBeenCalledWith(0, 'the prompt'.length);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(area.remove).toHaveBeenCalled();
    // Focus goes back where the person had it.
    expect(focused.focus).toHaveBeenCalled();
  });

  it('falls back when the API refuses, and says so when nothing took', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    page(false);
    expect(await copyText('the prompt')).toBe(false);
  });
});
