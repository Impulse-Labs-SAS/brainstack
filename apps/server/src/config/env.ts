// Environment configuration. Validated with zod at boot — if anything is
// missing or malformed the server refuses to start.

import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

const trueish = new Set(['1', 'true', 'yes', 'on']);

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NOTES_DIR: z.string().min(1).default('./brain'),
  DATABASE_URL: z.string().min(1).default('./data/brainstack.db'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_ORIGIN: z.string().url().default('http://localhost:3000'),
  SESSION_SECRET: z.string().min(16).default('dev-secret-please-change-at-least-32-bytes'),
  MCP_STDIO: z
    .string()
    .default('false')
    .transform((v) => trueish.has(v.toLowerCase())),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  RESEND_API_KEY: z.string().optional(),
  AUTH_EMAIL_FROM: z.string().optional(),
  AUTHORIZED_EMAILS: z.string().optional(),
  BACKUP_REPO: z.string().optional(),
  BACKUP_CRON: z.string().default('0 3 * * *'),
});

export type AppEnv = z.infer<typeof Env>;

export interface AppConfig extends AppEnv {
  /** Absolute, resolved NOTES_DIR. */
  notesDirAbs: string;
  /** Absolute, resolved DATABASE_URL when it is a file path. */
  databasePathAbs: string;
  /** Parsed authorized emails as a normalised set, empty if none configured. */
  authorizedEmails: Set<string>;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  loadDotenv();
  const parsed = Env.parse(process.env);
  const notesDirAbs = resolve(process.cwd(), parsed.NOTES_DIR);
  const databasePathAbs =
    parsed.DATABASE_URL === ':memory:'
      ? ':memory:'
      : resolve(process.cwd(), parsed.DATABASE_URL);
  const authorizedEmails = new Set(
    (parsed.AUTHORIZED_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  cached = { ...parsed, notesDirAbs, databasePathAbs, authorizedEmails };
  return cached;
}

/** Reset the cached config — only used by tests. */
export function _resetConfigForTests(): void {
  cached = null;
}
