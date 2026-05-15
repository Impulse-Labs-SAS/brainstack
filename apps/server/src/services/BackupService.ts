// Periodic two-step backup:
//   1. Snapshot the sqlite DB into BACKUP_DIR/brainstack.db using sqlite's
//      `.backup` command — safe-while-live, no need to lock the runtime DB.
//   2. Mirror NOTES_DIR into BACKUP_DIR/notes/ (unless NOTES_DIR is already
//      inside BACKUP_DIR), then `git add . && git commit && git push`.
//
// Failures never crash the server. The cron runs in a separate promise; if
// a tick fires while the previous run is still in flight it is skipped.

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';

export interface BackupServiceOptions {
  notesDir: string;
  /** Absolute sqlite DB path the runtime uses. */
  databasePath: string;
  /** Local git working tree where everything lands. */
  backupDir?: string;
  /** Remote URL added as `origin` when initialising the repo. */
  remote?: string;
  cronExpression: string;
  logger: Logger;
}

const SQLITE_BIN = process.env.SQLITE_BIN ?? 'sqlite3';

export class BackupService {
  private task: ScheduledTask | null = null;
  private running = false;

  constructor(private readonly opts: BackupServiceOptions) {}

  start(): void {
    if (!this.opts.backupDir) {
      this.opts.logger.info('backup disabled (no BACKUP_DIR configured)');
      return;
    }
    if (this.opts.databasePath === ':memory:') {
      this.opts.logger.warn('backup disabled (in-memory database cannot be snapshotted)');
      return;
    }
    if (!cron.validate(this.opts.cronExpression)) {
      this.opts.logger.error(
        { expr: this.opts.cronExpression },
        'invalid BACKUP_CRON expression — backups disabled',
      );
      return;
    }
    this.task = cron.schedule(this.opts.cronExpression, () => {
      if (this.running) {
        this.opts.logger.warn('backup tick skipped — previous run still in flight');
        return;
      }
      void this.run();
    });
    this.opts.logger.info(
      {
        schedule: this.opts.cronExpression,
        backupDir: this.opts.backupDir,
        remote: this.opts.remote ?? null,
      },
      'backup cron started',
    );
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Run a single backup cycle. Exposed for tests and a future admin endpoint. */
  async run(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.opts.backupDir) return { ok: false, reason: 'no BACKUP_DIR' };
    if (this.running) return { ok: false, reason: 'already running' };
    this.running = true;
    try {
      await this.ensureRepo();
      const dbResult = await this.snapshotSqlite();
      if (!dbResult.ok) return dbResult;

      const notesResult = await this.mirrorNotes();
      if (!notesResult.ok) return notesResult;

      await this.git(['add', '-A']);
      const status = await this.git(['status', '--porcelain']);
      if (status.trim() === '') {
        this.opts.logger.debug('backup: nothing to commit');
        return { ok: true, reason: 'no changes' };
      }

      const stamp = new Date().toISOString();
      await this.git(['commit', '-m', `backup ${stamp}`]);
      if (this.opts.remote) {
        try {
          await this.git(['push', 'origin', 'HEAD']);
          this.opts.logger.info({ stamp }, 'backup pushed');
        } catch (err) {
          this.opts.logger.error(
            { err },
            'backup: push failed — commit kept locally, next run will retry',
          );
          return { ok: false, reason: 'push failed' };
        }
      } else {
        this.opts.logger.info({ stamp }, 'backup committed (no remote configured)');
      }
      return { ok: true };
    } catch (err) {
      this.opts.logger.error({ err }, 'backup failed');
      return { ok: false, reason: err instanceof Error ? err.message : 'unknown' };
    } finally {
      this.running = false;
    }
  }

  private async snapshotSqlite(): Promise<{ ok: boolean; reason?: string }> {
    const target = join(this.opts.backupDir!, 'brainstack.db');
    const tmp = `${target}.tmp`;
    try {
      await fsp.rm(tmp, { force: true });
    } catch {
      // ignore
    }
    try {
      await runProcess(SQLITE_BIN, [this.opts.databasePath, `.backup '${tmp.replace(/'/g, "''")}'`]);
    } catch (err) {
      this.opts.logger.error({ err }, 'backup: sqlite .backup failed');
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      return { ok: false, reason: 'sqlite .backup failed' };
    }
    await fsp.rename(tmp, target);
    return { ok: true };
  }

  private async mirrorNotes(): Promise<{ ok: boolean; reason?: string }> {
    const backup = resolve(this.opts.backupDir!);
    const notes = resolve(this.opts.notesDir);
    // If NOTES_DIR already lives inside BACKUP_DIR (recommended layout),
    // there's nothing to mirror — `git add -A` will pick it up directly.
    const rel = relative(backup, notes);
    if (!rel.startsWith('..') && !rel.includes(`..${sep}`)) {
      return { ok: true };
    }
    const target = join(backup, 'notes');
    try {
      await fsp.cp(notes, target, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      this.opts.logger.error({ err }, 'backup: mirror failed');
      return { ok: false, reason: 'mirror failed' };
    }
  }

  private async ensureRepo(): Promise<void> {
    const dir = this.opts.backupDir!;
    await fsp.mkdir(dir, { recursive: true });
    const gitDir = join(dir, '.git');
    const exists = await fsp
      .stat(gitDir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await this.git(['init']);
      await this.git(['checkout', '-B', 'main']);
    }
    if (this.opts.remote) {
      const currentRemote = await this.git(['remote']).catch(() => '');
      if (!currentRemote.split(/\s+/).includes('origin')) {
        await this.git(['remote', 'add', 'origin', this.opts.remote]);
      }
    }
  }

  private git(args: string[]): Promise<string> {
    return runProcess('git', args, this.opts.backupDir);
  }
}

function runProcess(bin: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(bin, args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code === 0) resolveP(stdout);
      else rejectP(new Error(`${bin} ${args.join(' ')} failed: ${stderr || stdout}`));
    });
  });
}

// keep dirname imported via node:path
void dirname;
