// CRUD over notes. Each write goes through @brainstack/core (atomic
// filesystem) and then triggers an immediate reindex so the sqlite cache
// stays in sync without waiting for the chokidar event (the watcher will
// dedupe the event by checksum).

import {
  NoteAlreadyExistsError,
  NoteNotFoundError,
  deleteNote,
  moveNote,
  readNote,
  writeNote,
  type BrainStackDatabase,
  type Frontmatter,
} from '@brainstack/core';
import matter from 'gray-matter';

import { AppError } from '../lib/errors.js';

import type { IndexService } from './IndexService.js';

export interface NoteRowDto {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  body: string;
  mtime: number;
  checksum: string;
}

export interface ListFilter {
  folder?: string;
  tag?: string;
  status?: string;
  limit?: number;
}

export interface NoteServiceOptions {
  root: string;
  db: BrainStackDatabase;
  index: IndexService;
}

export class NoteService {
  constructor(private readonly opts: NoteServiceOptions) {}

  async get(path: string): Promise<NoteRowDto> {
    const row = this.opts.db.sqlite
      .prepare<[string], { path: string; title: string; frontmatter: string; body: string; mtime: number; checksum: string }>(
        'SELECT path, title, frontmatter, body, mtime, checksum FROM notes WHERE path = ?',
      )
      .get(path);
    if (!row) {
      // Fall back to disk if the file exists but isn't indexed yet.
      try {
        const file = await readNote(this.opts.root, path);
        await this.opts.index.reindex(file.path);
        return this.get(file.path);
      } catch (err) {
        if (err instanceof NoteNotFoundError) {
          throw new AppError(`note not found: ${path}`, 'NOT_FOUND', 404);
        }
        throw err;
      }
    }
    return {
      path: row.path,
      title: row.title,
      frontmatter: JSON.parse(row.frontmatter) as Frontmatter,
      body: row.body,
      mtime: row.mtime,
      checksum: row.checksum,
    };
  }

  async create(path: string, content: string, frontmatter?: Frontmatter): Promise<string> {
    const merged = frontmatter ? buildContent(content, frontmatter) : content;
    try {
      const finalPath = await writeNote(this.opts.root, path, merged, { failIfExists: true });
      await this.opts.index.reindex(finalPath);
      return finalPath;
    } catch (err) {
      if (err instanceof NoteAlreadyExistsError) {
        throw new AppError(`note already exists: ${path}`, 'ALREADY_EXISTS', 409);
      }
      throw err;
    }
  }

  async update(path: string, content: string): Promise<string> {
    try {
      // Confirm the note exists first; update semantics differ from create.
      await readNote(this.opts.root, path);
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        throw new AppError(`note not found: ${path}`, 'NOT_FOUND', 404);
      }
      throw err;
    }
    const finalPath = await writeNote(this.opts.root, path, content);
    await this.opts.index.reindex(finalPath);
    return finalPath;
  }

  async remove(path: string): Promise<void> {
    try {
      await deleteNote(this.opts.root, path);
    } catch (err) {
      if (err instanceof NoteNotFoundError) {
        throw new AppError(`note not found: ${path}`, 'NOT_FOUND', 404);
      }
      throw err;
    }
    this.opts.index.remove(path);
  }

  async move(fromPath: string, toPath: string): Promise<string> {
    const finalPath = await moveNote(this.opts.root, fromPath, toPath);
    this.opts.index.remove(fromPath);
    await this.opts.index.reindex(finalPath);
    return finalPath;
  }

  list(filter: ListFilter = {}): Array<{ path: string; title: string; mtime: number }> {
    const limit = filter.limit ?? 200;
    const parts: string[] = ['SELECT n.path, n.title, n.mtime FROM notes n'];
    const params: unknown[] = [];
    const where: string[] = [];

    if (filter.tag) {
      parts.push('JOIN tags t ON t.note_path = n.path');
      where.push('t.tag = ?');
      params.push(filter.tag);
    }
    if (filter.folder) {
      where.push('n.path LIKE ?');
      params.push(`${filter.folder.replace(/\/+$/, '')}/%`);
    }
    if (filter.status) {
      where.push("json_extract(n.frontmatter, '$.status') = ?");
      params.push(filter.status);
    }

    if (where.length > 0) parts.push('WHERE ' + where.join(' AND '));
    parts.push('ORDER BY n.mtime DESC LIMIT ?');
    params.push(limit);

    return this.opts.db.sqlite
      .prepare<unknown[], { path: string; title: string; mtime: number }>(parts.join(' '))
      .all(...params);
  }

  listLinks(path: string): Array<{
    sourcePath: string;
    targetPath: string;
    targetType: string;
    linkKind: string;
    alias: string | null;
    section: string | null;
  }> {
    return this.opts.db.sqlite
      .prepare<
        [string],
        {
          source_path: string;
          target_path: string;
          target_type: string;
          link_kind: string;
          alias: string | null;
          section: string | null;
        }
      >(
        `SELECT source_path, target_path, target_type, link_kind, alias, section
         FROM links WHERE target_path = ?
         ORDER BY source_path, position`,
      )
      .all(path)
      .map((row) => ({
        sourcePath: row.source_path,
        targetPath: row.target_path,
        targetType: row.target_type,
        linkKind: row.link_kind,
        alias: row.alias,
        section: row.section,
      }));
  }

  /** Append-to-inbox helper. Generates a deterministic filename if not given. */
  async addToInbox(content: string, title?: string): Promise<string> {
    const base = title?.trim() || defaultInboxTitle();
    const slug = slugify(base);
    const today = new Date().toISOString().slice(0, 10);
    const filename = `${today}-${slug}.md`;
    const path = `Inbox/${filename}`;

    const fm = {
      created: today,
      tags: ['inbox'],
      ...(title?.trim() ? { title: title.trim() } : {}),
    };

    return this.create(path, content, fm);
  }
}

function buildContent(body: string, frontmatter: Frontmatter): string {
  return matter.stringify(body, frontmatter);
}

function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60) || 'note';
}

function defaultInboxTitle(): string {
  return `note-${Date.now()}`;
}
