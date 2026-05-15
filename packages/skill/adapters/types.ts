// Shared types for the skill adapters. Each adapter takes the canonical
// INSTRUCTIONS.md content and returns one or more output files.

export interface AdapterOutput {
  /** Path relative to dist/<client>/. */
  filename: string;
  contents: string;
}

export interface SkillSource {
  /** Raw INSTRUCTIONS.md content, including frontmatter. */
  raw: string;
  /** Body with the frontmatter block stripped. */
  body: string;
  /** Parsed frontmatter (name, description, ...). */
  frontmatter: Record<string, unknown>;
}

export type Adapter = (source: SkillSource) => AdapterOutput[];
