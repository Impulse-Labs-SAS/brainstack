// A note's first lines as plain text, for a glance at it without opening it: the link peek
// beside a wikilink, the graph's preview sheet. Markdown is stripped, a leading `# title` goes
// (the title is shown already), and wikilinks read as their text.

export function excerpt(body: string, max = 260): string {
  return body
    .split('\n')
    .filter((l, i) => !(i === 0 && /^#\s/.test(l)))
    .join(' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[#>*_`]|^\s*[-+]\s/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
