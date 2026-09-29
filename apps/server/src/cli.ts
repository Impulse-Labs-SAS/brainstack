// Operator commands, run on the server itself.
//
//   node dist/cli.js reset-password <email>
//   docker compose exec server node dist/cli.js reset-password <email>
//
// reset-password is the way back into an account on an instance without email,
// where no reset link can be sent. It prints a new random password once, marks
// the address verified and signs the account out everywhere. Whoever can run a
// command on the server already owns the data, so it asks for nothing else.

import { ensurePgSchema, openPgDatabase } from '@brainstack/core/pg';
import pino from 'pino';

import { loadConfig } from './config/env.js';
import { AppError } from './lib/errors.js';
import { AuthService } from './services/AuthService.js';

const USAGE = 'usage: cli reset-password <email>';

async function main(argv: string[]): Promise<number> {
  const [command, email] = argv;
  if (command !== 'reset-password' || !email) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const cfg = loadConfig();
  const { db, close } = openPgDatabase(cfg.DATABASE_URL);
  try {
    await ensurePgSchema(db);
    const auth = new AuthService({
      db,
      email: null,
      logger: pino({ level: 'silent' }),
      publicOrigin: cfg.PUBLIC_ORIGIN,
      authorizedEmails: cfg.authorizedEmails,
    });
    const password = await auth.resetPasswordFromServer(email);
    process.stdout.write(
      `New password for ${email}:\n\n  ${password}\n\n` +
        'Every session of this account was signed out. ' +
        'Sign in with it, then change it under Settings → Account.\n',
    );
    return 0;
  } catch (err) {
    if (err instanceof AppError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    await close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
