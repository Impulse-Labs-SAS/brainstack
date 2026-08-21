// Environment configuration. Validated with zod at boot — if anything is
// missing or malformed the server refuses to start.

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const trueish = new Set(['1', 'true', 'yes', 'on']);

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** Postgres connection string. No default: there is nothing sensible to guess. */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required: a Postgres connection string (postgres://...). ' +
      'Use a Neon development branch, not production.')
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message:
        'DATABASE_URL must be a Postgres connection string. A file path is a leftover ' +
        'from when notes lived in sqlite; storage is Postgres now.',
    }),
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
  /** Comma-separated origins allowed by CORS. Default: localhost dev web. */
  CORS_ORIGINS: z.string().default('http://localhost:3001'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
  /**
   * Deployment mode. `self-host` is one user and no sharing; `hosted` gives
   * every note an owner and turns folder sharing on. See docs/Sharing-design.md.
   */
  BRAINSTACK_DEPLOYMENT: z.enum(['self-host', 'hosted']).default('self-host'),
});

export type AppEnv = z.infer<typeof Env>;

export interface AppConfig extends AppEnv {
  /** Parsed authorized emails as a normalised set, empty if none configured. */
  authorizedEmails: Set<string>;
  corsOrigins: string[];
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  loadDotenv();
  const parsed = Env.parse(process.env);
  const authorizedEmails = new Set(
    (parsed.AUTHORIZED_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const corsOrigins = parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  cached = { ...parsed, authorizedEmails, corsOrigins };
  return cached;
}

/** Reset the cached config — only used by tests. */
export function _resetConfigForTests(): void {
  cached = null;
}
