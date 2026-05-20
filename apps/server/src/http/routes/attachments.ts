// GET /api/attachments/<logical-path>
// Streams an attachment from disk with proper mime, Range support and an
// optional `?download=1` flag that forces Content-Disposition. The body is
// served straight off the filesystem — no base64 inflation, no react-query
// caching — so <video>/<audio>/PDF viewers work as expected.
//
// Authz: re-uses the user's vault scope (toPhysical/safeResolve). Cross-owner
// access is rejected as 404 (the path doesn't exist under the caller's
// vault). assertCanRead is called explicitly for the self-owner case so
// shared-folder rules can be plugged in later without changing the route.

import { promises as fsp, createReadStream, type Stats } from 'node:fs';
import { Hono } from 'hono';

import {
  PathTraversalError,
  relativeToRoot,
  safeResolve,
  toPosixPath,
} from '@brainstack/core';

import type { AuthBindings } from '../middleware/auth.js';
import type { SharingService } from '../../services/SharingService.js';
import { toPhysical, type VaultRootResolverConfig } from '../../lib/vault.js';

export interface AttachmentsRouterOptions {
  vaultCfg: VaultRootResolverConfig;
  sharing: SharingService;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  yaml: 'application/x-yaml; charset=utf-8',
  yml: 'application/x-yaml; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

export function mimeFromPath(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = path.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

interface ParsedRange {
  start: number;
  end: number;
}

export function parseRange(header: string, size: number): ParsedRange | 'invalid' | null {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return 'invalid';
  const startStr = m[1] ?? '';
  const endStr = m[2] ?? '';
  if (startStr === '' && endStr === '') return 'invalid';
  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range: last N bytes.
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  }
  if (start < 0 || end < start) return 'invalid';
  if (start >= size) return 'invalid';
  end = Math.min(end, size - 1);
  return { start, end };
}

export function createAttachmentsRouter(opts: AttachmentsRouterOptions): Hono<AuthBindings> {
  const app = new Hono<AuthBindings>();

  app.get('/*', async (c) => {
    const principal = c.get('principal');
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const userId = principal.user.id;

    const rawPath = decodeURIComponent(c.req.path.replace(/^\/api\/attachments\/?/, ''));
    if (!rawPath) return c.json({ error: 'missing path' }, 400);

    const logical = toPosixPath(rawPath);
    // El endpoint sirve cualquier binario; las notas .md se sirven vía
    // tRPC y no por acá (evita confusión y un hipotético render de la
    // fuente con cookie de auth).
    if (logical.toLowerCase().endsWith('.md')) {
      return c.json({ error: 'cannot serve .md via this endpoint' }, 400);
    }

    // Owner-aware: only the caller's vault is reachable. Cross-owner shared
    // folders that contain attachments will require lifting this — see
    // Sharing-design.md §6. For now we keep the strict scope and the
    // explicit assertCanRead call so adding shared attachments later is a
    // localised change.
    let absPath: string;
    let canonical: string;
    try {
      const physical = toPhysical(userId, logical, opts.vaultCfg);
      absPath = safeResolve(opts.vaultCfg.notesDirAbs, physical);
      canonical = relativeToRoot(opts.vaultCfg.notesDirAbs, absPath);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        return c.json({ error: 'invalid path' }, 400);
      }
      throw err;
    }

    // assertCanRead siempre passa para el propio user; queda explícito para
    // futuro cross-owner. relPath va sin prefix de owner.
    try {
      opts.sharing.assertCanRead(userId, userId, logical);
    } catch {
      return c.json({ error: 'forbidden' }, 403);
    }

    let stats: Stats;
    try {
      stats = await fsp.stat(absPath);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
    if (!stats.isFile()) return c.json({ error: 'not found' }, 404);

    const mime = mimeFromPath(canonical);
    const downloadFlag = c.req.query('download');
    const baseHeaders: Record<string, string> = {
      'Content-Type': mime,
      'Cache-Control': 'private, max-age=3600',
      'Accept-Ranges': 'bytes',
    };
    if (downloadFlag === '1' || downloadFlag === 'true') {
      const filename = canonical.split('/').pop() ?? 'download';
      baseHeaders['Content-Disposition'] = `attachment; filename="${sanitizeFilename(filename)}"`;
    }

    const rangeHeader = c.req.header('range');
    if (rangeHeader) {
      const parsed = parseRange(rangeHeader, stats.size);
      if (parsed === 'invalid') {
        return new Response(null, {
          status: 416,
          headers: {
            'Content-Range': `bytes */${stats.size}`,
          },
        });
      }
      if (parsed) {
        const { start, end } = parsed;
        const length = end - start + 1;
        const stream = createReadStream(absPath, { start, end });
        return new Response(toWebStream(stream), {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${stats.size}`,
            'Content-Length': String(length),
          },
        });
      }
    }

    const stream = createReadStream(absPath);
    return new Response(toWebStream(stream), {
      status: 200,
      headers: {
        ...baseHeaders,
        'Content-Length': String(stats.size),
      },
    });
  });

  return app;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w. -]+/g, '_');
}

function toWebStream(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  // node:stream/web has Readable.toWeb but typings vary across Node versions;
  // a manual adapter keeps this portable.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk) => {
        controller.enqueue(
          typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk as Buffer),
        );
      });
      stream.on('end', () => controller.close());
      stream.on('error', (err) => controller.error(err));
    },
    cancel() {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    },
  });
}
