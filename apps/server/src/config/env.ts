// Environment configuration. Validated with zod at boot — if anything is
// missing or malformed the server refuses to start.

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import type { EmailConfig } from '../services/EmailSender.js';

const trueish = new Set(['1', 'true', 'yes', 'on']);

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** Postgres connection string. No default: there is nothing sensible to guess. */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required: a Postgres connection string (postgres://...).')
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message:
        'DATABASE_URL must be a Postgres connection string. A file path is a leftover ' +
        'from when notes lived in sqlite; storage is Postgres now.',
    }),
  PORT: z.coerce.number().int().positive().default(3000),
  // Trailing slash stripped: this becomes the OAuth issuer and is concatenated
  // with paths, so 'https://site/' would produce 'https://site//api/oauth/...'
  // and break discovery. Every other consumer already strips it; this is the
  // one place it is guaranteed once.
  PUBLIC_ORIGIN: z
    .string()
    .url()
    .default('http://localhost:3000')
    .transform((v) => v.replace(/\/+$/, '')),
  MCP_STDIO: z
    .string()
    .default('false')
    .transform((v) => trueish.has(v.toLowerCase())),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  // Email. Resend's API or any SMTP server; either needs AUTH_EMAIL_FROM.
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  // An empty value in .env means "not set", not port 0.
  SMTP_PORT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive().default(587),
  ),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** TLS from the first byte. Defaults to on for port 465, off otherwise (STARTTLS). */
  SMTP_SECURE: z.string().optional(),
  AUTH_EMAIL_FROM: z.string().optional(),
  // Who may create an account once the first one exists. See AuthService.signup.
  AUTHORIZED_EMAILS: z.string().optional(),
  OPEN_SIGNUP: z
    .string()
    .default('false')
    .transform((v) => trueish.has(v.toLowerCase())),
  /** Comma-separated origins allowed by CORS. Default: localhost dev web. */
  CORS_ORIGINS: z.string().default('http://localhost:3001'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
  /**
   * Days the Crawl view keeps what `gather_context` gave each user. 0 turns the
   * history off and deletes what was kept. An empty value means the default.
   */
  CRAWL_HISTORY_DAYS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(3650).default(30),
  ),
});

export type AppEnv = z.infer<typeof Env>;

export interface AppConfig extends AppEnv {
  /** Parsed authorized emails as a normalised set, empty if none configured. */
  authorizedEmails: Set<string>;
  corsOrigins: string[];
  email: EmailConfig;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  // Quiet: dotenv otherwise prints a banner to stdout, which is the JSON-RPC
  // channel under stdio MCP and the output of the reset-password command.
  loadDotenv({ quiet: true });
  const parsed = Env.parse(process.env);
  const authorizedEmails = new Set(
    (parsed.AUTHORIZED_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const corsOrigins = parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const email: EmailConfig = {
    resendApiKey: parsed.RESEND_API_KEY || undefined,
    smtp: parsed.SMTP_HOST
      ? {
          host: parsed.SMTP_HOST,
          port: parsed.SMTP_PORT,
          secure: parsed.SMTP_SECURE
            ? trueish.has(parsed.SMTP_SECURE.toLowerCase())
            : parsed.SMTP_PORT === 465,
          user: parsed.SMTP_USER || undefined,
          password: parsed.SMTP_PASSWORD || undefined,
        }
      : undefined,
    from: parsed.AUTH_EMAIL_FROM || undefined,
  };
  cached = { ...parsed, authorizedEmails, corsOrigins, email };
  return cached;
}

/** Reset the cached config — only used by tests. */
export function _resetConfigForTests(): void {
  cached = null;
}
