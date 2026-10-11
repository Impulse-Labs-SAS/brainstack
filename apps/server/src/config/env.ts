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
    })
    // Said here, and without the value: a password with `/`, `#` or `?` in it
    // breaks the URL, and the driver's own error hides why (and the server
    // restarts in a loop). Never echo the string; it holds the password.
    .refine((v) => URL.canParse(v), {
      message:
        'DATABASE_URL does not parse as a URL. If the password contains characters such as ' +
        '/ # ? @ or :, percent-encode them (encodeURIComponent), or pick a password without them.',
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
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /**
   * Which header names the client for rate limiting. `proxy` (the default)
   * believes the last X-Forwarded-For entry, which the reverse proxy in front
   * writes — Caddy in docker-compose.yml. `direct` uses the socket address,
   * for a server with nothing in front. The Netlify function sets its own.
   */
  // `proxy`, `direct`, or `header:<Name>` for a CDN or tunnel in front of
  // Caddy that names the client in a header of its own (CF-Connecting-IP).
  TRUSTED_PROXY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .union([
        z.enum(['proxy', 'direct']),
        z
          .string()
          .regex(
            /^header:[A-Za-z0-9-]+$/,
            'TRUSTED_PROXY must be proxy, direct, or header:<Header-Name>',
          )
          .transform((v) => v as `header:${string}`),
      ])
      .default('proxy'),
  ),
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
   * Days the Sentinel view keeps what `gather_context` gave each user. 0 turns the
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
  // Quiet: dotenv otherwise prints a banner to stdout, which is where the
  // reset-password command writes its output.
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
