import { describe, expect, it } from 'vitest';

import {
  buildCodeMask,
  extractFrontmatter,
  extractLinks,
  extractTags,
  parseNote,
  serializeNote,
} from './index.js';

describe('extractFrontmatter', () => {
  it('returns empty frontmatter when no block is present', () => {
    const result = extractFrontmatter('# Just a heading\n\nbody');
    expect(result.hadFrontmatter).toBe(false);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('# Just a heading\n\nbody');
  });

  it('parses well-formed YAML frontmatter', () => {
    const raw = '---\ntitle: Hello\ntags: [a, b/c]\n---\n# Body\n';
    const result = extractFrontmatter(raw);
    expect(result.hadFrontmatter).toBe(true);
    expect(result.malformed).toBe(false);
    expect(result.frontmatter).toEqual({ title: 'Hello', tags: ['a', 'b/c'] });
    expect(result.body.trim()).toBe('# Body');
  });

  it('recovers from malformed YAML without throwing', () => {
    const raw = '---\nbad: [\nstill: bad\n---\nbody\n';
    const result = extractFrontmatter(raw);
    expect(result.hadFrontmatter).toBe(true);
    expect(result.malformed).toBe(true);
    expect(result.frontmatter).toEqual({});
  });

  it('gives an unquoted YAML date back as the day its author wrote', () => {
    const raw = '---\ncreated: 2026-09-14\nseen: [2026-01-02]\nnested: { at: 2026-03-04 }\n---\nbody\n';
    expect(extractFrontmatter(raw).frontmatter).toEqual({
      created: '2026-09-14',
      seen: ['2026-01-02'],
      nested: { at: '2026-03-04' },
    });
  });

  it('keeps the time of a timestamp that has one', () => {
    const raw = '---\nat: 2026-09-14T10:30:00Z\n---\nbody\n';
    expect(extractFrontmatter(raw).frontmatter).toEqual({ at: '2026-09-14T10:30:00.000Z' });
  });
});

describe('frontmatter never runs code', () => {
  // gray-matter evaluated a block opened with `---js`. These would set the
  // flag if any engine other than plain YAML ever saw the text again.
  const PAYLOAD = '---js\n(globalThis.__bsEvaluated = true, { title: "x" })\n---\nbody\n';

  it('treats a `---js` block as body text', () => {
    const result = extractFrontmatter(PAYLOAD);
    expect(result.hadFrontmatter).toBe(false);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(PAYLOAD);
    expect((globalThis as { __bsEvaluated?: boolean }).__bsEvaluated).toBeUndefined();
  });

  it('writes a `---js` body back without parsing it', () => {
    const out = serializeNote({ title: 'Note' }, PAYLOAD);
    expect((globalThis as { __bsEvaluated?: boolean }).__bsEvaluated).toBeUndefined();
    expect(extractFrontmatter(out)).toMatchObject({ frontmatter: { title: 'Note' }, body: PAYLOAD });
  });

  it('refuses YAML tags that build functions or objects', () => {
    const raw = '---\nx: !!js/function "function () { return 1 }"\n---\nbody\n';
    expect(extractFrontmatter(raw)).toMatchObject({ malformed: true, frontmatter: {} });
  });
});

describe('serializeNote', () => {
  it('round-trips frontmatter and body', () => {
    const fm = { title: 'Hello', tags: ['a', 'b/c'], created: '2026-09-14', nested: { n: 1 } };
    const out = serializeNote(fm, '# Body\n\ntext\n');
    expect(extractFrontmatter(out)).toMatchObject({ frontmatter: fm, body: '# Body\n\ntext\n' });
  });

  it('keeps a body that starts with a horizontal rule exactly as written', () => {
    for (const body of [
      '---\nfirst paragraph after a rule\n\nsecond\n',
      '---\nsecret: leaked\n---\nvisible\n',
      '---\n',
    ]) {
      const out = serializeNote({ title: 'T' }, body);
      expect(extractFrontmatter(out)).toMatchObject({ frontmatter: { title: 'T' }, body });
    }
  });

  it('writes no block for an empty frontmatter', () => {
    expect(serializeNote({}, 'body')).toBe('body');
    expect(serializeNote(null, 'body')).toBe('body');
  });

  it('drops values YAML cannot hold instead of failing', () => {
    const out = serializeNote({ a: 1, b: undefined } as Record<string, unknown>, 'x');
    expect(extractFrontmatter(out).frontmatter).toEqual({ a: 1 });
  });
});

describe('extractFrontmatter edge cases', () => {
  it('reads an opening rule with nothing closing it as body, not YAML', () => {
    const raw = '---\nfirst paragraph after a rule\n';
    expect(extractFrontmatter(raw)).toMatchObject({ frontmatter: {}, body: raw });
  });

  it('accepts an empty block and a block of comments', () => {
    expect(extractFrontmatter('---\n---\nbody')).toMatchObject({ frontmatter: {}, body: 'body', malformed: false });
    expect(extractFrontmatter('---\n# note\n---\nbody')).toMatchObject({ frontmatter: {}, body: 'body', malformed: false });
  });

  it('keeps a block that is not a mapping in the body', () => {
    const raw = '---\n- a\n- b\n---\nbody';
    expect(extractFrontmatter(raw)).toMatchObject({ frontmatter: {}, body: raw, malformed: true });
  });

  it('handles CRLF line endings', () => {
    expect(extractFrontmatter('---\r\ntitle: A\r\n---\r\nbody')).toMatchObject({ frontmatter: { title: 'A' }, body: 'body' });
  });
});

describe('extractLinks', () => {
  function links(body: string) {
    return extractLinks(body, buildCodeMask(body));
  }

  it('extracts plain wikilinks', () => {
    const result = links('See [[Pricing]] and [[Erebor/Pricing|the doc]].');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      rawTarget: 'Pricing',
      kind: 'wikilink',
      alias: null,
      isEmbed: false,
    });
    expect(result[1]).toMatchObject({
      rawTarget: 'Erebor/Pricing',
      alias: 'the doc',
      kind: 'wikilink',
    });
  });

  it('extracts embeds', () => {
    const result = links('![[Attachments/2026/05/img.png]]\n![[Note]]');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      rawTarget: 'Attachments/2026/05/img.png',
      kind: 'embed',
      isEmbed: true,
    });
    expect(result[1]).toMatchObject({ rawTarget: 'Note', kind: 'embed', isEmbed: true });
  });

  it('extracts wikilinks with sections', () => {
    const [link] = links('See [[Nota#Sección Importante|texto]].');
    expect(link).toMatchObject({
      rawTarget: 'Nota',
      section: 'Sección Importante',
      alias: 'texto',
    });
  });

  it('skips wikilinks inside inline code', () => {
    const result = links('not a link: `[[Nope]]` but yes [[Yes]].');
    expect(result).toHaveLength(1);
    expect(result[0]?.rawTarget).toBe('Yes');
  });

  it('skips wikilinks inside fenced code blocks', () => {
    const body = '```\n[[Inside]]\n```\n[[Outside]]\n';
    const result = links(body);
    expect(result).toHaveLength(1);
    expect(result[0]?.rawTarget).toBe('Outside');
  });

  it('extracts markdown links to local paths but ignores external URLs', () => {
    const result = links('[a](./local.md) and [b](https://example.com)');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      rawTarget: './local.md',
      kind: 'markdown',
      alias: 'a',
    });
  });
});

describe('extractTags', () => {
  function tags(body: string) {
    return extractTags(body, buildCodeMask(body));
  }

  it('extracts flat and nested tags', () => {
    expect(tags('Some #erebor and #proyecto/erebor tags.')).toEqual(['erebor', 'proyecto/erebor']);
  });

  it('does not treat headings as tags', () => {
    expect(tags('# Heading\n\nbody #real-tag')).toEqual(['real-tag']);
  });

  it('ignores tags inside code blocks and spans', () => {
    const body = '`#nope` text #real\n```\n#alsonope\n```';
    expect(tags(body)).toEqual(['real']);
  });

  it('rejects numeric-only tags and trailing slashes', () => {
    expect(tags('issue #123 and #invalid/')).toEqual([]);
  });
});

describe('parseNote', () => {
  it('derives title from frontmatter > H1 > filename', () => {
    expect(parseNote('---\ntitle: FM\n---\n# H1\n', { path: 'x.md' }).title).toBe('FM');
    expect(parseNote('# H1\nbody', { path: 'x.md' }).title).toBe('H1');
    expect(parseNote('body', { path: 'folder/note.md' }).title).toBe('note');
  });

  it('produces a stable checksum and merges frontmatter tags with body tags', () => {
    const raw = '---\ntags: [persona/frodo]\n---\n#erebor body\n';
    const a = parseNote(raw);
    const b = parseNote(raw);
    expect(a.checksum).toBe(b.checksum);
    expect(a.tags).toEqual(['persona/frodo', 'erebor']);
  });

  it('changes the checksum when only the frontmatter changes', () => {
    const before = parseNote('---\ntags: [a]\n---\nsame body\n');
    const after = parseNote('---\ntags: [a, b]\n---\nsame body\n');
    expect(after.checksum).not.toBe(before.checksum);
  });

  it('produces empty links and tags for trivial input', () => {
    const result = parseNote('just text');
    expect(result.links).toHaveLength(0);
    expect(result.tags).toHaveLength(0);
  });
});
