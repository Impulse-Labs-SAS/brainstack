import type { Config } from 'drizzle-kit';

export default {
  schema: './src/pg/schema.ts',
  out: './src/pg/drizzle',
  dialect: 'postgresql',
} satisfies Config;
