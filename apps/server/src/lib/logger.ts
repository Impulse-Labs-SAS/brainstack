// Structured logger built on pino, to stdout.

import pino, { type Logger } from 'pino';

import { loadConfig } from '../config/env.js';

let cached: Logger | null = null;

export function getLogger(): Logger {
  if (cached) return cached;
  const cfg = loadConfig();
  cached = pino({ level: cfg.LOG_LEVEL, base: { service: 'brainstack' } });
  return cached;
}
