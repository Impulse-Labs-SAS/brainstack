// A note's first lines as plain text, for a glance at it without opening it: the link peek
// beside a wikilink, the graph's preview sheet. Markdown is stripped, a leading `# title` goes
// (the title is shown already), and wikilinks read as their text.

export function excerpt(body: string, max = 260): string {
  const lines = body.split('\n');
  // After frontmatter a body starts with a blank line, and its title is on the next one.
  const first = lines.findIndex((l) => l.trim() !== '');
  return (
    lines
      .filter((l, i) => !(i === first && /^#\s/.test(l)))
      // A list item's marker, line by line: once the lines are joined, it is mid-text.
      .map((l) => l.replace(/^\s*[-+]\s/, ''))
      .join(' ')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/[#>*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}
