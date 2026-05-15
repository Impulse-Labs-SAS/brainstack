// Periodic git-based backup of NOTES_DIR.
// On every tick we `git add . && git commit && git push` from inside the
// notes directory. If the directory isn't a git repo yet, we initialise it
// with the configured remote. Failures are logged but never crash the server.

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import cron, { type ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';

export interface BackupServiceOptions {
  notesDir: string;
  cronExpression: string;
  remote?: string;
  logger: Logger;
}

export class BackupService {
  private task: ScheduledTask | null = null;

  constructor(private readonly opts: BackupServiceOptions) {}

  start(): void {
    if (!this.opts.remote) {
      this.opts.logger.info('backup disabled (no BACKUP_REPO configured)');
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
      void this.run();
    });
    this.opts.logger.info(
      { schedule: this.opts.cronExpression, remote: this.opts.remote },
      'backup cron started',
    );
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Run a single backup cycle. Exposed for the /admin/backup-now endpoint
   * (added in a later phase) and for tests. */
  async run(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.opts.remote) return { ok: false, reason: 'no remote' };
    try {
      await this.ensureRepo();
      await this.git(['add', '.']);
      const status = await this.git(['status', '--porcelain']);
      if (status.trim() === '') {
        this.opts.logger.debug('backup: nothing to commit');
        return { ok: true, reason: 'no changes' };
      }
      const stamp = new Date().toISOString();
      await this.git(['commit', '-m', `backup ${stamp}`]);
      await this.git(['push', 'origin', 'HEAD']);
      this.opts.logger.info('backup pushed');
      return { ok: true };
    } catch (err) {
      this.opts.logger.error({ err }, 'backup failed');
      return { ok: false, reason: err instanceof Error ? err.message : 'unknown' };
    }
  }

  private async ensureRepo(): Promise<void> {
    const gitDir = join(this.opts.notesDir, '.git');
    const exists = await fsp.stat(gitDir).then(() => true).catch(() => false);
    if (exists) return;
    await fsp.mkdir(this.opts.notesDir, { recursive: true });
    await this.git(['init']);
    if (this.opts.remote) {
      await this.git(['remote', 'add', 'origin', this.opts.remote]);
    }
    await this.git(['checkout', '-B', 'main']);
  }

  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: this.opts.notesDir });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => (stdout += b.toString()));
      child.stderr.on('data', (b) => (stderr += b.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`));
      });
    });
  }
}
