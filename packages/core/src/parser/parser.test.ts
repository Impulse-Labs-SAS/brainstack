import { describe, expect, it } from 'vitest';

import {
  buildCodeMask,
  extractFrontmatter,
  extractLinks,
  extractTags,
  parseNote,
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

describe('extractLinks', () => {
  function links(body: string) {
    return extractLinks(body, buildCodeMask(body));
  }

  it('extracts plain wikilinks', () => {
    const result = links('See [[Pricing]] and [[Zuno/Pricing|the doc]].');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      rawTarget: 'Pricing',
      kind: 'wikilink',
      alias: null,
      isEmbed: false,
    });
    expect(result[1]).toMatchObject({
      rawTarget: 'Zuno/Pricing',
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
    expect(tags('Some #zuno and #proyecto/zuno tags.')).toEqual(['zuno', 'proyecto/zuno']);
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
    const raw = '---\ntags: [persona/pablo]\n---\n#zuno body\n';
    const a = parseNote(raw);
    const b = parseNote(raw);
    expect(a.checksum).toBe(b.checksum);
    expect(a.tags).toEqual(['persona/pablo', 'zuno']);
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
