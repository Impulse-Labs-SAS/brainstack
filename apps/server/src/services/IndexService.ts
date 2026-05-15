// Wraps the indexer + watcher from @brainstack/core. Owns lifecycle:
// bootstrap once on boot, then keep the watcher running until shutdown.

import {
  bootstrapIndex,
  ensureRootExists,
  reindexFile,
  removeFromIndex,
  startWatcher,
  type BrainStackDatabase,
  type BootstrapResult,
  type WatcherEvent,
  type WatcherHandle,
} from '@brainstack/core';

import type { Logger } from 'pino';

export interface IndexServiceOptions {
  root: string;
  db: BrainStackDatabase;
  logger: Logger;
}

export class IndexService {
  private watcherHandle: WatcherHandle | null = null;

  constructor(private readonly opts: IndexServiceOptions) {}

  async bootstrap(): Promise<BootstrapResult> {
    await ensureRootExists(this.opts.root);
    const result = await bootstrapIndex(this.opts.root, this.opts.db);
    this.opts.logger.info(
      {
        notesIndexed: result.notesIndexed,
        attachments: result.attachmentsIndexed,
        unresolved: result.unresolvedLinks,
        ambiguous: result.ambiguousLinks,
      },
      'index bootstrap complete',
    );
    return result;
  }

  startWatching(onChange?: (event: WatcherEvent) => void): void {
    if (this.watcherHandle) return;
    this.watcherHandle = startWatcher(this.opts.root, this.opts.db, {
      onChange: (event) => {
        this.opts.logger.debug({ event }, 'watcher event applied');
        onChange?.(event);
      },
      onError: (err) => this.opts.logger.error({ err }, 'watcher error'),
    });
    this.opts.logger.info({ root: this.opts.root }, 'watcher started');
  }

  async stopWatching(): Promise<void> {
    if (!this.watcherHandle) return;
    await this.watcherHandle.close();
    this.watcherHandle = null;
  }

  /** Force a reindex of a single file (after a direct mutation). */
  async reindex(path: string): Promise<void> {
    await reindexFile(this.opts.root, this.opts.db, path);
  }

  /** Remove a file from the index (after delete). */
  remove(path: string): void {
    removeFromIndex(this.opts.db, path);
  }
}
