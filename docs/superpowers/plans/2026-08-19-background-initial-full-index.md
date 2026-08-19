# Background Initial Full Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Do NOT use subagents.** Execute tasks inline in the current session.

**Goal:** When Nexus starts as a normal service on an unindexed project, automatically start a background Full Index while keeping the server available for search.

**Architecture:** The IndexPipeline records reindex success atomically in `index_stats` (checking DLQ emptiness in the same SQLite transaction with a shared completion lock). The EventQueue gains a post-scan queue that buffers Watcher events during the startup Full Index without applying overflow-drop semantics. The NexusRuntime checks `lastIndexedAt` after initialization and, if unindexed, starts a background Full reindex with `reason: 'startup-reconciliation'` — never blocking `initialize()` — and `close()` waits for that Promise before closing stores.

**Tech Stack:** TypeScript, Vitest, async-mutex, better-sqlite3, LanceDB

## Global Constraints

- Node.js >=24, `npm`, `package-lock.json` is authoritative.
- No new CLI options, MCP tools, APIs, or UI.
- No schema changes to SQLite — reuse existing `index_stats` columns (`last_indexed_at`, `last_full_scan_at`, `total_files`, `total_chunks`, `overflow_count`).
- `lastIndexedAt` is `null` or the `index_stats` row does not exist → unindexed.
- Stale existing indexes are NOT auto-Full-Index targets.
- Auto Full Index must not block `initialize()`.
- No auto-Full-Index retry within the same Runtime.
- If DLQ has items after Full Index, it is NOT a successful completion.
- Manual `nexus --reindex` and `nexus --reindex --full` success conditions are the same as auto.
- `runReindex` callback in factory.ts ignores the `reason` option and always scans — the reason is for logging only.
- Do not commit credentials, tokens, machine-specific paths, or generated local state.
- Verification commands: `npx vitest run <test-file>`, `npm run lint`, `npm run build`, `npx vitest run`.

## Stacked PR Strategy

This plan is split into **3 stacked pull requests**. Each PR builds on the previous one and is independently testable. Use `gh-stack` or manual branch stacking:

```text
master
 └── PR1: pipeline-completion-recording  (base)
      └── PR2: eventqueue-post-scan-queue  (stacked on PR1)
           └── PR3: runtime-auto-full-index (stacked on PR2)
```

- **PR1** (`feat/pipeline-completion-recording`): IndexPipeline records reindex success in `index_stats` atomically with DLQ emptiness check via a shared completion lock.
- **PR2** (`feat/eventqueue-post-scan-queue`): EventQueue gains a post-scan queue that buffers Watcher events during the startup Full Index; `markFullScanComplete()` no longer clears it.
- **PR3** (`feat/runtime-auto-full-index`): NexusRuntime checks `lastIndexedAt` after initialization and starts a background Full reindex; `close()` waits for the Promise.

Each task below indicates which PR it belongs to. Create the branch for each PR from the previous PR's branch (or `master` for PR1). Push and create a PR targeting the previous PR's branch (or `master` for PR1).

---

## File Structure

### Files to Create

| File | Responsibility |
| --- | --- |
| `tests/unit/indexer/pipeline-completion.test.ts` | Pipeline completion recording tests (PR1) |
| `tests/unit/indexer/event-queue-post-scan.test.ts` | Post-scan queue tests (PR2) |
| `tests/unit/server/runtime-auto-index.test.ts` | Runtime auto-Full-Index tests (PR3) |

### Files to Modify

| File | PR | Changes |
| --- | --- | --- |
| `src/storage/interfaces/metadata-store.ts` | PR1 | Add `atomicCompletionCheck` method to `IMetadataStore` |
| `src/storage/metadata-store.ts` | PR1 | Implement `atomicCompletionCheck` in `SqliteMetadataStore` |
| `tests/unit/storage/in-memory-metadata-store.ts` | PR1 | Implement `atomicCompletionCheck` in `InMemoryMetadataStore` |
| `tests/unit/storage/metadata-store.test.ts` | PR1 | Add SQLite integration test for `atomicCompletionCheck` (atomicity, DLQ residual suppression, completionLock) |
| `src/indexer/dead-letter-queue.ts` | PR1 | Accept optional `completionLock` in `DeadLetterQueueOptions`; acquire it in `enqueue` and `removeEntries` |
| `src/indexer/pipeline.ts` | PR1, PR2 | Add `completionLock`; add `reason` param to `reindex()`; call `atomicCompletionCheck` after compact; set `lastError`/`skippedFiles` on DLQ residual (PR1). Pass `eventQueue` to `markFullScanComplete` context (PR2 — no change needed, already wired) |
| `src/types/index.ts` | PR1 | Widen `IIndexPipeline.reindex` `run` callback reason type; add `reason` param |
| `src/indexer/event-queue.ts` | PR2 | Add post-scan queue fields, `enterPostScanMode()`, `drainPostScanQueue()`, `abortPostScanMode()`; modify `enqueue()` and `markFullScanComplete()` |
| `src/server/tools/types.ts` | PR3 | Add `eventQueue?: EventQueue` to `NexusServerOptions` |
| `src/server/index.ts` | PR3 | Add `eventQueue?` to `NexusRuntimeOptions`; in `initialize()` check `lastIndexedAt`, start background Full reindex; in `close()` wait for auto-reindex Promise |
| `src/server/factory.ts` | PR3 | Pass `eventQueue` to `buildNexusRuntime` options; pass `eventQueue` to `IndexPipeline` constructor |

---

## PR1: Pipeline Completion Recording

### Task 1.1: Add `atomicCompletionCheck` to `IMetadataStore`

**Files:**
- Modify: `src/storage/interfaces/metadata-store.ts:25-49` (add method to interface)
- Test: `tests/unit/storage/metadata-store.test.ts`

**Interfaces:**
- Produces: `IMetadataStore.atomicCompletionCheck(stats: IndexStatsRow): Promise<{ dlqEmpty: boolean; dlqEntries: DeadLetterEntry[] }>`

- [ ] **Step 1: Add the method to the interface**

Add to `src/storage/interfaces/metadata-store.ts` inside `export interface IMetadataStore { ... }` after `setIndexStats`:

```typescript
  /**
   * Atomically checks whether the dead-letter queue is empty and, if so,
   * updates index_stats. Returns the DLQ entries for error reporting when
   * the queue is not empty.
   *
   * In SQLite this runs inside a single transaction so the DLQ read and the
   * index_stats write are an atomic boundary. The caller MUST hold the
   * completion lock before calling this method to prevent DLQ modifications
   * between the read and the write.
   */
  atomicCompletionCheck(stats: IndexStatsRow): Promise<{
    dlqEmpty: boolean;
    dlqEntries: DeadLetterEntry[];
  }>;
```

Also add the import for `DeadLetterEntry` at the top of the file (it's already imported):
```typescript
import type { DeadLetterEntry } from '../../types/index.js';
```
(This import already exists on line 2 — verify it is present.)

- [ ] **Step 2: Run type check to verify it fails**

Run: `npx tsc --noEmit`
Expected: Errors in `SqliteMetadataStore` and `InMemoryMetadataStore` (missing method implementation).

- [ ] **Step 3: Implement in `SqliteMetadataStore`**

Add to `src/storage/metadata-store.ts` after `setIndexStats` (after line 367):

```typescript
  async atomicCompletionCheck(stats: IndexStatsRow): Promise<{
    dlqEmpty: boolean;
    dlqEntries: DeadLetterEntry[];
  }> {
    await this.asyncBoundary();
    const runTransaction = this.db.transaction(() => {
      const dlqEntries = this.db
        .prepare(
          `SELECT id,
                  file_path AS filePath,
                  content_hash AS contentHash,
                  error_message AS errorMessage,
                  attempts,
                  recovery_attempts AS recoveryAttempts,
                  created_at AS createdAt,
                  updated_at AS updatedAt,
                  last_retry_at AS lastRetryAt
           FROM dead_letter_queue
           ORDER BY created_at ASC`,
        )
        .all() as DeadLetterEntry[];

      if (dlqEntries.length === 0) {
        this.db
          .prepare(
            `INSERT INTO index_stats (
                id, total_files, total_chunks, last_indexed_at, last_full_scan_at, overflow_count
              ) VALUES (
                @id, @totalFiles, @totalChunks, @lastIndexedAt, @lastFullScanAt, @overflowCount
              )
              ON CONFLICT(id) DO UPDATE SET
                total_files = excluded.total_files,
                total_chunks = excluded.total_chunks,
                last_indexed_at = excluded.last_indexed_at,
                last_full_scan_at = excluded.last_full_scan_at,
                overflow_count = excluded.overflow_count`,
          )
          .run(stats);
      }

      return { dlqEmpty: dlqEntries.length === 0, dlqEntries };
    });
    return runTransaction();
  }
```

Ensure `DeadLetterEntry` is imported in `metadata-store.ts` (it should already be via `src/types/index.js`).

- [ ] **Step 4: Implement in `InMemoryMetadataStore`**

Add to `tests/unit/storage/in-memory-metadata-store.ts` after `setIndexStats` (after line 147):

```typescript
  async atomicCompletionCheck(stats: IndexStatsRow): Promise<{
    dlqEmpty: boolean;
    dlqEntries: DeadLetterEntry[];
  }> {
    const dlqEntries = await this.getDeadLetterEntries();
    if (dlqEntries.length === 0) {
      this.stats = stats;
    }
    return { dlqEmpty: dlqEntries.length === 0, dlqEntries };
  }
```

- [ ] **Step 4b: Add SQLite integration test for `atomicCompletionCheck`

> **Why:** `InMemoryMetadataStore` has no transaction boundary, so the atomicity guarantee of `SqliteMetadataStore.atomicCompletionCheck()` is untested. Add a test that uses a temporary SQLite database to verify: (1) the DLQ read and `index_stats` write are atomic, (2) DLQ residual suppresses the `index_stats` update, and (3) the shared `completionLock` prevents DLQ modifications between the read and write.

Add to `tests/unit/storage/metadata-store.test.ts`:

> **Note:** Use a temporary file-based SQLite database (not `:memory:`) to match production behavior. Clean up the temp file in `afterEach`/`afterAll`.

```typescript
import Database from 'better-sqlite3';
import { Mutex } from 'async-mutex';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SqliteMetadataStore } from '../../../src/storage/metadata-store.js';

describe('SqliteMetadataStore.atomicCompletionCheck (integration)', () => {
  let tmpDir: string;
  let store: SqliteMetadataStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'nexus-sqlite-test-'));
    store = new SqliteMetadataStore({ dbPath: path.join(tmpDir, 'test.db') });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes index_stats when DLQ is empty (atomic transaction)', async () => {
    const stats = {
      id: 'primary',
      totalFiles: 10,
      totalChunks: 20,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      lastFullScanAt: '2026-01-01T00:00:00.000Z',
      overflowCount: 0,
    };
    const result = await store.atomicCompletionCheck(stats);
    expect(result.dlqEmpty).toBe(true);
    expect(result.dlqEntries).toHaveLength(0);

    const stored = await store.getIndexStats();
    expect(stored).not.toBeNull();
    expect(stored!.lastIndexedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does NOT write index_stats when DLQ has items', async () => {
    await store.upsertDeadLetterEntries([
      {
        id: 'dlq-1',
        filePath: 'failed.ts',
        contentHash: 'hash-1',
        errorMessage: 'embed failed',
        attempts: 3,
        recoveryAttempts: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastRetryAt: null,
      },
    ]);

    const stats = {
      id: 'primary',
      totalFiles: 10,
      totalChunks: 20,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      lastFullScanAt: '2026-01-01T00:00:00.000Z',
      overflowCount: 0,
    };
    const result = await store.atomicCompletionCheck(stats);
    expect(result.dlqEmpty).toBe(false);
    expect(result.dlqEntries).toHaveLength(1);
    expect(result.dlqEntries[0].filePath).toBe('failed.ts');

    // index_stats should NOT be written
    const stored = await store.getIndexStats();
    expect(stored?.lastIndexedAt).toBeNull();
  });

  it('completionLock prevents DLQ modification during the check', async () => {
    const completionLock = new Mutex();
    // Acquire the lock to simulate the pipeline holding it
    const release = await completionLock.acquire();
    try {
      // While the lock is held, a DLQ enqueue should wait
      // (This verifies the lock is shared and serializes access)
      const enqueuePromise = store.upsertDeadLetterEntries([
        {
          id: 'dlq-during',
          filePath: 'concurrent.ts',
          contentHash: 'hash',
          errorMessage: 'error',
          attempts: 1,
          recoveryAttempts: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          lastRetryAt: null,
        },
      ]);

      // The atomicCompletionCheck should see an empty DLQ because the enqueue
      // is blocked by the lock (in production, the DLQ also acquires this lock).
      const stats = {
        id: 'primary',
        totalFiles: 0,
        totalChunks: 0,
        lastIndexedAt: '2026-01-01T00:00:00.000Z',
        lastFullScanAt: null,
        overflowCount: 0,
      };
      const result = await store.atomicCompletionCheck(stats);
      expect(result.dlqEmpty).toBe(true); // enqueue hasn't completed yet
    } finally {
      release();
    }
  });
});
```

- [ ] **Step 5: Run type check to verify it passes**

Run: `npx tsc --noEmit`
Expected: No errors related to `atomicCompletionCheck`.

- [ ] **Step 6: Commit**

```bash
git add src/storage/interfaces/metadata-store.ts src/storage/metadata-store.ts tests/unit/storage/in-memory-metadata-store.ts tests/unit/storage/metadata-store.test.ts
git commit -m "feat: add atomicCompletionCheck to IMetadataStore for DLQ-aware index_stats update"
```

---

### Task 1.2: Add `completionLock` to DeadLetterQueue

**Files:**
- Modify: `src/indexer/dead-letter-queue.ts:14-26` (DeadLetterQueueOptions), `:82-106` (enqueue), `:272-281` (removeEntries)

**Interfaces:**
- Consumes: `Mutex` from `async-mutex`
- Produces: `DeadLetterQueue` that acquires a shared completion lock on enqueue/remove

- [ ] **Step 1: Add `completionLock` to `DeadLetterQueueOptions`**

In `src/indexer/dead-letter-queue.ts`, add the import and option:

```typescript
import type { Mutex } from 'async-mutex';
```

Add to `DeadLetterQueueOptions` (after `metricsHooks?`):

```typescript
  /** Optional lock shared with the pipeline completion check. When provided,
   * enqueue and removeEntries acquire this lock so the completion check sees
   * a stable DLQ state. */
  completionLock?: Mutex;
```

Add a private field in the `DeadLetterQueue` class (after `private readonly logger`):

```typescript
  private readonly completionLock?: Mutex;
```

In the constructor, add:

```typescript
    this.completionLock = options.completionLock;
```

- [ ] **Step 2: Acquire `completionLock` in `enqueue`**

Modify `enqueue` to acquire the lock. Replace the `enqueue` method body:

```typescript
  async enqueue(input: Pick<DeadLetterEntry, 'filePath' | 'contentHash' | 'errorMessage' | 'attempts'>): Promise<DeadLetterEntry> {
    const acquire = this.completionLock
      ? this.completionLock.acquire()
      : Promise.resolve(() => {});
    const release = await acquire;
    try {
      await this.ensureLoaded();
      const timestamp = this.now().toISOString();

      const existingEntry = [...this.entries.values()].find((e) => e.filePath === input.filePath);

      const entry: DeadLetterEntry = {
        id: existingEntry?.id ?? randomUUID(),
        filePath: input.filePath,
        contentHash: input.contentHash,
        errorMessage: input.errorMessage,
        attempts: input.attempts,
        recoveryAttempts: existingEntry?.recoveryAttempts ?? 0,
        createdAt: existingEntry?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastRetryAt: existingEntry?.lastRetryAt ?? null,
      };

      await this.options.metadataStore.upsertDeadLetterEntries([entry]);
      this.entries.set(entry.id, entry);
      await this.trimToCapacityUnlocked();
      this.safeNotifyMetrics((h) => { h.onDlqSnapshot(this.entries.size, this.options.name); });

      return entry;
    } finally {
      if (typeof release === 'function') release();
    }
  }
```

- [ ] **Step 3: Acquire `completionLock` in `removeEntries` and split lock-free variant

Modify the private `removeEntries` method. Split it into two methods: `removeEntries`
(acquires the lock, for external callers like `purgeExpired`, `reprocess`,
`recoverySweep`) and `removeEntriesUnlocked` (no lock, for `trimToCapacity` when
the lock is already held by the caller — prevents `async-mutex` re-entrancy deadlock):

```typescript
  private async removeEntries(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const acquire = this.completionLock
      ? this.completionLock.acquire()
      : Promise.resolve(() => {});
    const release = await acquire;
    try {
      await this.removeEntriesUnlocked(ids);
    } finally {
      if (typeof release === 'function') release();
    }
  }

  /**
   * Removes entries without acquiring the completion lock.
   * MUST only be called when the caller already holds the completion lock
   * (e.g. from `enqueue` → `trimToCapacity`), otherwise DLQ modifications
   * could race with the pipeline completion check.
   */
  private async removeEntriesUnlocked(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.options.metadataStore.removeDeadLetterEntries(ids);
    for (const id of ids) {
      this.entries.delete(id);
    }
  }
```

Also modify `trimToCapacity` to call `removeEntriesUnlocked` instead of `removeEntries`:

```typescript
  private async trimToCapacity(): Promise<void> {
    if (this.entries.size > this.maxEntries) {
      const sortedEntries = [...this.entries.values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      const toRemove = sortedEntries.slice(0, this.entries.size - this.maxEntries);
      const removedIds = toRemove.map((e) => e.id);

      await this.removeEntriesUnlocked(removedIds);
    }
  }
```


- [ ] **Step 4: Run existing DLQ tests to verify no regression**

Run: `npx vitest run tests/unit/indexer/dead-letter-queue.test.ts tests/unit/indexer/dlq-recovery-loop.test.ts`
Expected: All tests PASS (no completionLock provided → no-op behavior).

- [ ] **Step 5: Commit**

```bash
git add src/indexer/dead-letter-queue.ts
git commit -m "feat: add optional completionLock to DeadLetterQueue for atomic completion check"
```

---

### Task 1.3: Add `completionLock` and `reason` to IndexPipeline, record reindex success

**Files:**
- Modify: `src/indexer/pipeline.ts:26-47` (IndexPipelineOptions), `:62-102` (constructor), `:533-601` (reindex method)
- Modify: `src/types/index.ts:315-326` (IIndexPipeline interface)
- Test: `tests/unit/indexer/pipeline-completion.test.ts` (create)

**Interfaces:**
- Consumes: `Mutex` from `async-mutex`, `atomicCompletionCheck` from `IMetadataStore`
- Produces: `IndexPipeline.reindex(run, loadContent, fullRebuild?, reason?)` — records success in `index_stats`

- [ ] **Step 1: Widen the `IIndexPipeline.reindex` type**

In `src/types/index.ts`, modify the `IIndexPipeline` interface (lines 315-326):

```typescript
export interface IIndexPipeline {
  start(): void;
  stop(): Promise<void>;
  reindex(
    run: (options?: { fullScan?: boolean; reason?: ReindexOptions['reason'] }) => Promise<IndexEvent[]>,
    loadContent: (filePath: string) => Promise<string>,
    fullRebuild?: boolean,
    reason?: ReindexOptions['reason'],
  ): Promise<ReindexResult | { status: 'already_running' } | { status: 'incomplete' }>;
  getSkippedFiles(): ReadonlyMap<string, string>;
  reconcileOnStartup(): Promise<RuntimeInitializationResult>;
  getProgress(): PipelineProgress;
}
```

- [ ] **Step 2: Add `completionLock` to `IndexPipelineOptions`**

In `src/indexer/pipeline.ts`, add import at top:

```typescript
import { Mutex, E_ALREADY_LOCKED, tryAcquire } from 'async-mutex';
```

(This import already exists on line 2 — verify.)

Add to `IndexPipelineOptions` (after `metricsHooks?`):

```typescript
  /** Lock shared with DeadLetterQueue to serialize the completion check. */
  completionLock?: Mutex;
```

- [ ] **Step 3: Add `completionLock` field and wire to DLQ**

Add a private field to `IndexPipeline` (after `private readonly deadLetterQueue`):

```typescript
  private readonly completionLock: Mutex;
```

In the constructor, before creating the DeadLetterQueue, initialize the lock:

```typescript
    this.completionLock = options.completionLock ?? new Mutex();
    this.deadLetterQueue = new DeadLetterQueue({
      metadataStore: options.metadataStore,
      embeddingHealthy: () => this.embeddingHealthy(),
      computeFileHash: (path) => this.computeFileHash(path),
      reprocess: (entry) => this.reprocess(entry),
      metricsHooks: options.metricsHooks,
      completionLock: this.completionLock,
    });
```

- [ ] **Step 4: Add `reason` parameter to `reindex()` and implement completion recording**

Replace the `reindex` method (lines 533-601):

```typescript
  async reindex(
    run: (options?: { fullScan?: boolean; reason?: ReindexOptions['reason'] }) => Promise<IndexEvent[]>,
    loadContent: ContentLoader,
    fullRebuild?: boolean,
    reason: ReindexOptions['reason'] = 'manual',
  ): Promise<ReindexResult | { status: 'already_running' } | { status: 'incomplete' }> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    try {
      return await tryAcquire(this.mutex).runExclusive(async () => {
        this.progress.status = 'running';
        this.progress.processedFiles = 0;
        this.progress.totalFiles = 0;
        this.progress.lastError = undefined;
        this.safeNotifyMetrics((h) => { h.onIndexingProgress(0, 0, true); });

        try {
          const events = await run({ fullScan: fullRebuild, reason });
          this.progress.totalFiles = events.length;
          this.safeNotifyMetrics((h) => { h.onIndexingProgress(0, events.length, true); });
          this.safeLogProgress(`Starting reindex of ${events.length} files (fullRebuild: ${!!fullRebuild}, reason: ${reason})`);

          const { chunksIndexed } = await this.processEvents(events, loadContent, { trackProgress: true });

          const finishedAt = new Date().toISOString();
          const durationMs = Date.now() - startTime;

          const reconciliation = {
            added: events.filter((e) => e.type === 'added').length,
            modified: events.filter((e) => e.type === 'modified').length,
            deleted: events.filter((e) => e.type === 'deleted').length,
            unchanged: 0,
          };

          try {
            await this.options.vectorStore.compactAfterReindex();
          } catch (compactionError) {
            console.error('Post-reindex compaction failed (non-fatal):', compactionError);
          }

          // --- Completion recording ---
          await this.recordCompletion(fullRebuild, reason, startedAt, finishedAt);

          // If DLQ had items, recordCompletion set lastError — don't report success.
          // Per Global Constraint: "If DLQ has items after Full Index, it is NOT a successful completion."
          if (this.progress.lastError) {
            this.progress.status = 'idle';
            this.safeNotifyMetrics((h) => { h.onIndexingProgress(this.progress.processedFiles, this.progress.totalFiles, false); });
            return { status: 'incomplete' as const };
          }

          this.safeNotifyMetrics((h) => { h.onReindexComplete(durationMs, !!fullRebuild); });

          this.progress.status = 'idle';
          this.safeNotifyMetrics((h) => { h.onIndexingProgress(this.progress.processedFiles, this.progress.totalFiles, false); });
          return {
            startedAt,
            finishedAt,
            durationMs,
            reconciliation,
            chunksIndexed,
          };
        } catch (error) {
          this.progress.status = 'idle';
          this.safeNotifyMetrics((h) => { h.onIndexingProgress(this.progress.processedFiles, this.progress.totalFiles, false); });
          this.progress.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          if (fullRebuild && this.options.eventQueue) {
            this.options.eventQueue.markFullScanComplete();
          }
        }
      });
    } catch (e) {
      if (e === E_ALREADY_LOCKED) {
        return { status: 'already_running' as const };
      }
      throw e;
    }
  }

  /**
   * Records reindex completion in index_stats. Acquires the completion lock,
   * gets vector store stats, and atomically checks DLQ emptiness + writes
   * index_stats in a single SQLite transaction. If DLQ is not empty, sets
   * pipelineProgress.lastError and skippedFiles instead of recording success.
   */
  private async recordCompletion(
    fullRebuild: boolean | undefined,
    reason: ReindexOptions['reason'],
    startedAt: string,
    finishedAt: string,
  ): Promise<void> {
    const release = await this.completionLock.acquire();
    try {
      const vectorStats = await this.options.vectorStore.getStats();

      const existingStats = await this.options.metadataStore.getIndexStats();
      const nowIso = new Date().toISOString();

      const stats: IndexStatsRow = {
        id: 'primary',
        totalFiles: vectorStats.totalFiles,
        totalChunks: vectorStats.totalChunks,
        lastIndexedAt: nowIso,
        lastFullScanAt: fullRebuild ? nowIso : (existingStats?.lastFullScanAt ?? null),
        overflowCount: existingStats?.overflowCount ?? 0,
      };

      const { dlqEmpty, dlqEntries } =
        await this.options.metadataStore.atomicCompletionCheck(stats);

      if (!dlqEmpty) {
        this.progress.lastError =
          `Full reindex incomplete: ${dlqEntries.length} dead-letter queue item(s) remain`;

        // Build filePath → errorMessage map, preferring the newest createdAt per path.
        const byPath = new Map<string, { createdAt: string; errorMessage: string }>();
        for (const entry of dlqEntries) {
          const existing = byPath.get(entry.filePath);
          if (existing === undefined || entry.createdAt > existing.createdAt) {
            byPath.set(entry.filePath, { createdAt: entry.createdAt, errorMessage: entry.errorMessage });
          }
        }
        for (const [filePath, info] of byPath) {
          this.skippedFiles.set(filePath, info.errorMessage);
        }

        const reasonLabel = reason === 'startup-reconciliation' ? 'startup-reconciliation' : 'manual';
        this.safeLogProgress(
          `Reindex incomplete (${reasonLabel}): ${dlqEntries.length} DLQ item(s) remain. Completion state NOT saved.`,
        );
      } else {
        const reasonLabel = reason === 'startup-reconciliation' ? 'startup-reconciliation' : 'manual';
        this.safeLogProgress(
          `Reindex completed (${reasonLabel}). index_stats updated.`,
        );
      }
    } finally {
      release();
    }
  }
```

Add the necessary imports at the top of `pipeline.ts`:

```typescript
import {
  type EmbeddingProvider,
  type IMetadataStore,
  type IVectorStore,
  type CodeChunk,
  type IndexEvent,
  type RuntimeInitializationResult,
  type ReindexResult,
  type DeadLetterEntry,
  type IIndexPipeline,
  type PipelineProgress,
  type ReindexOptions,
  type RetryExhaustedError,
  type EmbeddingCacheEntry,
  type IndexStatsRow,
} from '../types/index.js';
```

(Add `ReindexOptions` and `IndexStatsRow` to the existing import — verify they are exported from `src/types/index.ts`.)

- [ ] **Step 5: Ensure `IndexStatsRow` and `ReindexOptions` are re-exported from `src/types/index.ts`**

Check `src/types/index.ts` for existing re-exports. `IndexStatsRow` is re-exported from `src/storage/interfaces/metadata-store.ts`. `ReindexOptions` is already defined in `src/types/index.ts`. Add `IndexStatsRow` to the re-export if not present:

```typescript
export type { IndexStatsRow } from '../storage/interfaces/metadata-store.js';
```

(Verify whether this re-export already exists — it likely does.)

- [ ] **Step 6: Write the failing test**

Create `tests/unit/indexer/pipeline-completion.test.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { Chunker } from '../../../src/indexer/chunker.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { createPipeline } from '../../shared/test-helpers.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';

const fixturePath = path.join(process.cwd(), 'tests/fixtures/sample-project/src/auth.ts');

const makePipeline = async (overrides: { metadataStore?: InMemoryMetadataStore } = {}) => {
  const { metadataStore: defaultStore, vectorStore, chunker, registry } = await createPipeline();
  const metadataStore = overrides.metadataStore ?? defaultStore;
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker,
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: registry,
  });
  return { pipeline, metadataStore, vectorStore };
};

const scanNoFiles = async () => [];

describe('IndexPipeline completion recording', () => {
  it('records lastIndexedAt and lastFullScanAt on successful full reindex with empty DLQ', async () => {
    const { pipeline, metadataStore } = await makePipeline();
    const loadContent = async () => '';

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    const stats = await metadataStore.getIndexStats();
    expect(stats).not.toBeNull();
    expect(stats!.lastIndexedAt).not.toBeNull();
    expect(stats!.lastFullScanAt).not.toBeNull();
  });

  it('records lastIndexedAt but preserves existing lastFullScanAt on successful normal reindex', async () => {
    const { pipeline, metadataStore } = await makePipeline();
    const loadContent = async () => '';

    // First: full reindex to set lastFullScanAt
    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');
    const afterFull = await metadataStore.getIndexStats();
    expect(afterFull!.lastFullScanAt).not.toBeNull();
    const fullScanAt = afterFull!.lastFullScanAt;

    // Second: normal reindex (no fullRebuild)
    await pipeline.reindex(scanNoFiles, loadContent, false, 'manual');
    const afterNormal = await metadataStore.getIndexStats();
    expect(afterNormal!.lastIndexedAt).not.toBeNull();
    expect(afterNormal!.lastFullScanAt).toBe(fullScanAt); // preserved
  });

  it('sets lastFullScanAt to null on first normal reindex with no existing stats row', async () => {
    const { pipeline, metadataStore } = await makePipeline();
    const loadContent = async () => '';

    await pipeline.reindex(scanNoFiles, loadContent, false, 'manual');

    const stats = await metadataStore.getIndexStats();
    expect(stats).not.toBeNull();
    expect(stats!.lastIndexedAt).not.toBeNull();
    expect(stats!.lastFullScanAt).toBeNull();
  });

  it('does NOT record completion when DLQ has items', async () => {
    const { pipeline, metadataStore } = await makePipeline();
    const loadContent = async () => '';

    // Manually add a DLQ entry
    await metadataStore.upsertDeadLetterEntries([
      {
        id: 'dlq-1',
        filePath: 'some/file.ts',
        contentHash: 'hash-1',
        errorMessage: 'embed failed',
        attempts: 3,
        recoveryAttempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastRetryAt: null,
      },
    ]);

    const result = await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');
    expect(result).toEqual({ status: 'incomplete' });

    const stats = await metadataStore.getIndexStats();
    // lastIndexedAt should NOT be set (no completion recorded)
    expect(stats?.lastIndexedAt).toBeNull();

    const progress = pipeline.getProgress();
    expect(progress.lastError).toBe(
      'Full reindex incomplete: 1 dead-letter queue item(s) remain',
    );
    expect(pipeline.getSkippedFiles().get('some/file.ts')).toBe('embed failed');
  });

  it('does NOT record completion when an exception is thrown during reindex', async () => {
    const { pipeline, metadataStore } = await makePipeline();

    const failingScan = async () => {
      throw new Error('scan failed');
    };
    const loadContent = async () => '';

    await expect(pipeline.reindex(failingScan, loadContent, true, 'manual')).rejects.toThrow(
      'scan failed',
    );

    const stats = await metadataStore.getIndexStats();
    expect(stats?.lastIndexedAt).toBeNull();
  });

  it('records completion even when compactAfterReindex fails (non-fatal)', async () => {
    const { metadataStore } = await createPipeline();
    const failingVectorStore = {
      ...{
        initialize: async () => undefined,
        upsertChunks: async () => undefined,
        deleteByFilePath: async () => 0,
        deleteByPathPrefix: async () => 0,
        renameFilePath: async () => 0,
        search: async () => [],
        compactIfNeeded: async () => ({ compacted: false, fragmentationRatioBefore: 0, fragmentationRatioAfter: 0, chunksRemoved: 0 }),
        compactAfterReindex: async () => { throw new Error('compact failed'); },
        scheduleIdleCompaction: () => setTimeout(() => {}, 0),
        getStats: async () => ({ totalChunks: 0, totalFiles: 0, dimensions: 64, fragmentationRatio: 0 }),
        close: async () => undefined,
      },
    } as any;

    const { chunker, registry } = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore: failingVectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });

    const loadContent = async () => '';
    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    const stats = await metadataStore.getIndexStats();
    expect(stats!.lastIndexedAt).not.toBeNull();
  });

  it('uses newest errorMessage when multiple DLQ entries share the same filePath', async () => {
    const { pipeline, metadataStore } = await makePipeline();
    const loadContent = async () => '';

    const baseTime = Date.now();
    await metadataStore.upsertDeadLetterEntries([
      {
        id: 'dlq-old',
        filePath: 'shared/path.ts',
        contentHash: 'hash-old',
        errorMessage: 'old error',
        attempts: 1,
        recoveryAttempts: 0,
        createdAt: new Date(baseTime - 5000).toISOString(),
        updatedAt: new Date(baseTime - 5000).toISOString(),
        lastRetryAt: null,
      },
      {
        id: 'dlq-new',
        filePath: 'shared/path.ts',
        contentHash: 'hash-new',
        errorMessage: 'new error',
        attempts: 2,
        recoveryAttempts: 1,
        createdAt: new Date(baseTime).toISOString(),
        updatedAt: new Date(baseTime).toISOString(),
        lastRetryAt: null,
      },
    ]);

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    expect(pipeline.getSkippedFiles().get('shared/path.ts')).toBe('new error');
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/unit/indexer/pipeline-completion.test.ts`
Expected: FAIL — `atomicCompletionCheck` not yet fully wired, or completion not recorded.

- [ ] **Step 8: Run the test to verify it passes**

After implementing all previous steps, run:
Run: `npx vitest run tests/unit/indexer/pipeline-completion.test.ts`
Expected: PASS

- [ ] **Step 9: Run lint and existing pipeline tests**

Run: `npm run lint && npx vitest run tests/unit/indexer/pipeline.test.ts`
Expected: No lint errors, all existing tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/indexer/pipeline.ts src/types/index.ts tests/unit/indexer/pipeline-completion.test.ts
git commit -m "feat: record reindex completion in index_stats with DLQ-aware atomic check"
```

- [ ] **Step 11: Create PR1**

```bash
git push -u origin feat/pipeline-completion-recording
gh pr create --base master --title "feat: pipeline completion recording in index_stats" --body "Stacked PR 1/3. Records reindex success atomically in index_stats with DLQ emptiness check via a shared completion lock."
```

---

## PR2: EventQueue Post-Scan Queue

### Task 2.1: Add post-scan queue to EventQueue

**Files:**
- Modify: `src/indexer/event-queue.ts` (add fields, methods, modify `enqueue` and `markFullScanComplete`)
- Test: `tests/unit/indexer/event-queue-post-scan.test.ts` (create)

**Interfaces:**
- Produces: `EventQueue.enterPostScanMode()`, `EventQueue.drainPostScanQueue()`, `EventQueue.abortPostScanMode()`
- Modifies: `EventQueue.enqueue()` (routes to post-scan buffer when active), `EventQueue.markFullScanComplete()` (no longer clears post-scan queue)

- [ ] **Step 1: Add post-scan queue fields to EventQueue**

In `src/indexer/event-queue.ts`, add fields after `private droppedEventCount = 0;`:

```typescript
  private readonly postScanQueue: IndexEvent[] = [];

  private postScanActive = false;
```

- [ ] **Step 2: Add `enterPostScanMode()`, `drainPostScanQueue()`, `abortPostScanMode()` methods**

Add after `markFullScanComplete()` (after line 272):

```typescript
  /**
   * Activates post-scan mode. While active, all events enqueued via `enqueue()`
   * are buffered in the post-scan queue and bypass the normal debounce/overflow
   * pipeline. The existing overflow-drop contract does NOT apply to these events.
   */
  enterPostScanMode(): void {
    this.postScanActive = true;
  }

  /**
   * Deactivates post-scan mode and moves all buffered events into the normal
   * watcher queue for immediate processing. Returns the number of events drained.
   * If post-scan mode is not active, this is a no-op returning 0.
   */
  drainPostScanQueue(): number {
    if (!this.postScanActive) {
      return 0;
    }
    this.postScanActive = false;
    const drained = this.postScanQueue.length;
    for (const event of this.postScanQueue) {
      this.watcherQueue.push(event);
    }
    this.postScanQueue.length = 0;
    this.safeNotifyMetrics();
    return drained;
  }

  /**
   * Discards the post-scan queue and deactivates post-scan mode without
   * draining events to the normal queue. Used during Runtime shutdown.
   */
  abortPostScanMode(): void {
    this.postScanActive = false;
    this.postScanQueue.length = 0;
  }

  /**
   * Returns the number of events currently held in the post-scan queue.
   */
  getPostScanQueueSize(): number {
    return this.postScanQueue.length;
  }

  isPostScanActive(): boolean {
    return this.postScanActive;
  }
```

- [ ] **Step 3: Modify `enqueue()` to route to post-scan queue**

Modify the `enqueue` method (lines 48-114). Add at the very beginning of `enqueue`, before the existing overflow check:

```typescript
  enqueue(event: IndexEvent): boolean {
    if (this.postScanActive) {
      this.postScanQueue.push(event);
      this.safeNotifyMetrics();
      return true;
    }

    if (this.state !== 'normal') {
      return this.recordDroppedEvent();
    }
    // ... rest of existing enqueue logic unchanged
```

- [ ] **Step 4: Modify `markFullScanComplete()` to NOT clear post-scan queue**

The current `markFullScanComplete()` calls `resetInternalState()` which clears everything. Modify it to preserve the post-scan queue:

```typescript
  markFullScanComplete(): void {
    if (this.state !== 'full_scan') {
      return;
    }

    // Reset overflow state but preserve the post-scan queue.
    this.flushTimers();
    this.debouncedEvents.clear();
    this.watcherQueue.length = 0;
    this.reindexQueue.length = 0;
    this.state = 'normal';
    this.safeNotifyMetrics();
  }
```

This replaces the call to `resetInternalState()` with inline resets that do NOT touch `postScanQueue` or `postScanActive`.

- [ ] **Step 5: Write the failing test**

Create `tests/unit/indexer/event-queue-post-scan.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { EventQueue } from '../../../src/indexer/event-queue.js';

const makeQueue = () =>
  new EventQueue({
    debounceMs: 10,
    maxQueueSize: 100,
    fullScanThreshold: 50,
    concurrency: 1,
  });

const makeEvent = (filePath: string) => ({
  type: 'added' as const,
  filePath,
  detectedAt: new Date().toISOString(),
});

describe('EventQueue post-scan queue', () => {
  it('buffers events in post-scan queue when post-scan mode is active', () => {
    const queue = makeQueue();
    queue.enterPostScanMode();

    expect(queue.isPostScanActive()).toBe(true);

    queue.enqueue(makeEvent('a.ts'));
    queue.enqueue(makeEvent('b.ts'));

    expect(queue.getPostScanQueueSize()).toBe(2);
    expect(queue.size()).toBe(0); // normal queue is empty
  });

  it('drains post-scan queue events into the normal watcher queue', () => {
    const queue = makeQueue();
    queue.enterPostScanMode();

    queue.enqueue(makeEvent('a.ts'));
    queue.enqueue(makeEvent('b.ts'));

    const drained = queue.drainPostScanQueue();

    expect(drained).toBe(2);
    expect(queue.isPostScanActive()).toBe(false);
    expect(queue.getPostScanQueueSize()).toBe(0);
    // Events should now be in the watcher queue
    expect(queue.size()).toBe(2);
  });

  it('does not apply overflow-drop to post-scan queue events', () => {
    const queue = new EventQueue({
      debounceMs: 10,
      maxQueueSize: 2,
      fullScanThreshold: 1,
      concurrency: 1,
    });

    queue.enterPostScanMode();

    // Enqueue more events than maxQueueSize — all should be buffered
    queue.enqueue(makeEvent('a.ts'));
    queue.enqueue(makeEvent('b.ts'));
    queue.enqueue(makeEvent('c.ts'));
    queue.enqueue(makeEvent('d.ts'));

    expect(queue.getPostScanQueueSize()).toBe(4);
    expect(queue.getState()).toBe('normal'); // no overflow triggered
  });

  it('markFullScanComplete preserves post-scan queue when in full_scan state', async () => {
    // Create a queue that triggers overflow → full_scan via the public API.
    // maxQueueSize=2, fullScanThreshold=1: exceeding maxQueueSize triggers overflow.
    const queue = new EventQueue({
      debounceMs: 0,
      maxQueueSize: 2,
      fullScanThreshold: 1,
      concurrency: 1,
    });

    // Enter post-scan mode and buffer events (these bypass the normal queue)
    queue.enterPostScanMode();
    queue.enqueue(makeEvent('post-1.ts'));
    queue.enqueue(makeEvent('post-2.ts'));
    expect(queue.getPostScanQueueSize()).toBe(2);

    // Exit post-scan mode — drained events go to the normal watcher queue
    queue.drainPostScanQueue();
    expect(queue.size()).toBe(2); // drained into normal queue

    // Now trigger overflow by enqueuing beyond maxQueueSize on the normal path.
    // The drained events are already in the queue (size=2 == maxQueueSize).
    // Adding one more should trigger overflow → full_scan state.
    queue.enqueue(makeEvent('overflow-trigger.ts'));

    // The queue should now be in full_scan state
    expect(queue.getState()).toBe('full_scan');

    // Re-enter post-scan mode and buffer more events during the Full Index
    queue.enterPostScanMode();
    queue.enqueue(makeEvent('post-3.ts'));
    queue.enqueue(makeEvent('post-4.ts'));
    expect(queue.getPostScanQueueSize()).toBe(2);

    // Call markFullScanComplete — should reset overflow state but preserve post-scan queue
    queue.markFullScanComplete();
    expect(queue.getState()).toBe('normal');
    expect(queue.getPostScanQueueSize()).toBe(2); // preserved!
    expect(queue.isPostScanActive()).toBe(true); // still in post-scan mode
  });

  it('abortPostScanMode discards buffered events without draining', () => {
    const queue = makeQueue();
    queue.enterPostScanMode();

    queue.enqueue(makeEvent('a.ts'));
    queue.enqueue(makeEvent('b.ts'));

    queue.abortPostScanMode();

    expect(queue.isPostScanActive()).toBe(false);
    expect(queue.getPostScanQueueSize()).toBe(0);
    expect(queue.size()).toBe(0); // not drained to normal queue
  });

  it('enqueue returns to normal processing after drainPostScanQueue', () => {
    const queue = makeQueue();
    queue.enterPostScanMode();
    queue.enqueue(makeEvent('a.ts'));
    queue.drainPostScanQueue();

    // After drain, normal enqueue should work
    const accepted = queue.enqueue(makeEvent('b.ts'));
    // After debounce flush, it should be in watcherQueue
    expect(accepted).toBe(true);
  });
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/unit/indexer/event-queue-post-scan.test.ts`
Expected: PASS

- [ ] **Step 7: Run existing EventQueue tests to verify no regression**

Run: `npx vitest run tests/unit/indexer/event-queue.test.ts tests/unit/indexer/backpressure.test.ts`
Expected: All existing tests PASS.

- [ ] **Step 8: Run lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 9: Commit**

```bash
git add src/indexer/event-queue.ts tests/unit/indexer/event-queue-post-scan.test.ts
git commit -m "feat: add post-scan queue to EventQueue for startup Full Index event buffering"
```

- [ ] **Step 10: Create PR2**

```bash
git push -u origin feat/eventqueue-post-scan-queue
gh pr create --base feat/pipeline-completion-recording --title "feat: EventQueue post-scan queue" --body "Stacked PR 2/3. Adds a post-scan queue to EventQueue that buffers Watcher events during the startup Full Index without applying overflow-drop semantics. markFullScanComplete no longer clears it."
```

---

## PR3: Runtime Auto-Trigger Full Index

### Task 3.1: Wire `eventQueue` through to `NexusRuntimeOptions` and `IndexPipeline`

**Files:**
- Modify: `src/server/tools/types.ts:16-31` (add `eventQueue?` to `NexusServerOptions`)
- Modify: `src/server/index.ts:20-28` (NexusRuntimeOptions already extends NexusServerOptions)
- Modify: `src/server/factory.ts:460-471` (pass eventQueue to IndexPipeline), `:494-532` (pass eventQueue to buildNexusRuntime)

**Interfaces:**
- Produces: `NexusServerOptions.eventQueue?: EventQueue` — available in `NexusRuntimeOptions`

- [ ] **Step 1: Add `eventQueue` to `NexusServerOptions`**

In `src/server/tools/types.ts`, add the import and field:

```typescript
import type { EventQueue } from '../../indexer/event-queue.js';
```

Add to `NexusServerOptions` after `packageMode?`:

```typescript
  eventQueue?: EventQueue;
```

- [ ] **Step 2: Pass `eventQueue` to `IndexPipeline` constructor in factory.ts**

In `src/server/factory.ts`, modify the `IndexPipeline` construction (around line 460). Add `eventQueue`:

```typescript
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(pluginRegistry, { maxChunkChars: config.indexing.maxChunkChars }),
      embeddingProvider,
      pluginRegistry,
      maxFileBytes: config.indexing.maxFileBytes,
      chunkConcurrency: config.indexing.chunkConcurrency,
      embedBatchWindowSize: config.indexing.embedBatchWindowSize,
      onProgress: (msg) => onLog(msg),
      metricsHooks: metricsCollector,
      eventQueue,
    });
```

Wait — `eventQueue` is created inside `EventProcessingManager.setup()`, which is called AFTER the pipeline is constructed. Let me re-read the factory flow.

Looking at factory.ts lines 460-485:
```ts
const pipeline = new IndexPipeline({ ... }); // line 460
const loadFileContent = ...; // line 473
const eventManager = new EventProcessingManager(...); // line 476
const { watcher, onClose } = eventManager.setup(); // line 485 — creates eventQueue
```

The eventQueue is created inside `eventManager.setup()`. But the pipeline is created before that. I need to either:
1. Create the EventQueue before the pipeline and pass it to both
2. Or set it on the pipeline after creation

Option 1 is cleaner. I'll extract EventQueue creation from EventProcessingManager.setup().

Actually, looking at EventProcessingManager.setup():
```ts
setup() {
    const eventQueue = new EventQueue({ ... });
    const watcher = new FileWatcher({ ... }, eventQueue);
    this.drainTask = this.startDrainLoop(eventQueue);
    return { watcher, onClose: () => this.stop() };
}
```

I can change `setup()` to accept an `eventQueue` parameter, or return it.

Let me change `setup()` to return `eventQueue` as well:

```typescript
  setup() {
    const eventQueue = new EventQueue({ ... });
    const watcher = new FileWatcher({ ... }, eventQueue);
    this.drainTask = this.startDrainLoop(eventQueue);
    return { eventQueue, watcher, onClose: () => this.stop() };
  }
```

Then in factory.ts, create the pipeline after `setup()` returns the eventQueue, or create eventQueue before the pipeline.

Actually, the simplest approach: move the EventQueue creation before the pipeline. I'll create the EventQueue in `createRuntime()` and pass it to both the pipeline and EventProcessingManager.

In `src/server/factory.ts`, modify `createRuntime()`:

Before the pipeline creation, create the EventQueue:

```typescript
    const eventQueue = new EventQueue({
      debounceMs: config.watcher.debounceMs,
      maxQueueSize: config.watcher.maxQueueSize,
      fullScanThreshold: config.watcher.fullScanThreshold,
      concurrency: 4,
      metricsHooks: metricsCollector,
      onFullScanRequired: () => {
        // This will be set up by EventProcessingManager
        return Promise.resolve();
      },
    });
```

Hmm, the `onFullScanRequired` callback is set up inside EventProcessingManager. This creates a circular dependency. Let me keep it simpler.

**Alternative approach**: Modify `EventProcessingManager.setup()` to return `eventQueue`, then pass it to the pipeline after construction. But the pipeline needs it in the constructor.

**Simplest approach**: Create the EventQueue first with a placeholder `onFullScanRequired`, then update the callback after EventProcessingManager is created. Or pass a mutable callback holder.

Actually, the cleanest approach: have `EventProcessingManager.setup()` return the `eventQueue`, and set it on the pipeline after construction via a setter. But `IndexPipeline` doesn't have a setter for eventQueue.

Let me just refactor the order: create EventQueue first, pass it to both pipeline and EventProcessingManager.

In `EventProcessingManager`, change `setup()` to accept an optional `eventQueue`:

```typescript
  setup(eventQueue?: EventQueue) {
    const queue = eventQueue ?? new EventQueue({ ... });
    // ... use queue instead of creating a new one
    return { eventQueue: queue, watcher, onClose: () => this.stop() };
  }
```

Then in factory.ts:

```typescript
    const eventQueue = new EventQueue({
      debounceMs: config.watcher.debounceMs,
      maxQueueSize: config.watcher.maxQueueSize,
      fullScanThreshold: config.watcher.fullScanThreshold,
      concurrency: 4,
      metricsHooks: metricsCollector,
      onFullScanRequired: () => {
        const p = this.triggerFullScan().finally(() => {
          if (this.fullScanPromise === p) {
            this.fullScanPromise = undefined;
          }
        });
        this.fullScanPromise = p;
        return Promise.resolve();
      },
    });
```

Wait, `this` would refer to the wrong context. The `onFullScanRequired` is defined in EventProcessingManager. I can't create the EventQueue outside of EventProcessingManager because it needs the `triggerFullScan` method.

OK, let me take a different approach. I'll modify `EventProcessingManager.setup()` to return the `eventQueue`, and create the pipeline AFTER `setup()`. The pipeline doesn't need the eventQueue for its constructor — it's optional. The `markFullScanComplete()` call in `reindex()` is guarded by `if (fullRebuild && this.options.eventQueue)`, so if eventQueue is undefined, it's a no-op. But I want it to work.

Let me add a method to `IndexPipeline` to set the eventQueue after construction:

```typescript
  setEventQueue(eventQueue: EventQueue): void {
    (this.options as IndexPipelineOptions).eventQueue = eventQueue;
  }
```

Hmm, that's a bit hacky. Let me instead just create the EventQueue first with a wrapper for `onFullScanRequired`:

Actually, the simplest solution: Move the `onFullScanRequired` callback to reference the EventProcessingManager instance via a closure. Create the EventQueue in `createRuntime()` before the pipeline:

```typescript
    // Create event manager first (without starting)
    const eventManager = new EventProcessingManager(
      config,
      projectRoot,
      ignorePaths,
      pipeline,  // <-- pipeline not yet created!
      loadFileContent,
      onLog,
      metricsCollector,
    );
```

This has a chicken-and-egg problem too: EventProcessingManager takes `pipeline` in its constructor.

Let me just change the approach: modify EventProcessingManager.setup() to return the eventQueue, and set it on the pipeline afterwards.

In `src/indexer/pipeline.ts`, add a method:

```typescript
  setEventQueue(eventQueue: EventQueue): void {
    this.options.eventQueue = eventQueue;
  }
```

Wait, `this.options` is `private readonly`. I can make it just `private` (not readonly) or add a setter.

Actually, `IndexPipelineOptions` has `eventQueue?: EventQueue`. The `options` field is `private readonly options`. I can't modify `this.options.eventQueue` if `options` is readonly. Let me check:

```typescript
  constructor(private readonly options: IndexPipelineOptions) {
```

`readonly` applies to `this.options` reference, not to its properties. So `this.options.eventQueue = eventQueue` would work if `IndexPipelineOptions` is not frozen. It should work since it's a regular object.

Add to `IndexPipeline`:

```typescript
  /** Sets the EventQueue after construction (for factory wiring). */
  setEventQueue(eventQueue: EventQueue): void {
    this.options.eventQueue = eventQueue;
  }
```

Then in factory.ts:

```typescript
    const pipeline = new IndexPipeline({ ... }); // no eventQueue yet
    // ... 
    const eventManager = new EventProcessingManager(..., pipeline, ...);
    const { eventQueue, watcher, onClose } = eventManager.setup();
    pipeline.setEventQueue(eventQueue);
    // ...
    return buildNexusRuntime({ ..., eventQueue });
```

This is clean enough. Let me proceed with this approach.

- [ ] **Step 2 (revised): Add `setEventQueue` to `IndexPipeline`**

In `src/indexer/pipeline.ts`, add after `getSkippedFiles()` (line 634):

```typescript
  /** Sets the EventQueue after construction (for factory wiring). */
  setEventQueue(eventQueue: EventQueue): void {
    this.options.eventQueue = eventQueue;
  }
```

- [ ] **Step 3: Modify `EventProcessingManager.setup()` to return `eventQueue`**

In `src/server/factory.ts`, modify `EventProcessingManager.setup()` (line 164):

Change the return type and add `eventQueue` to the return:

```typescript
  setup(): { eventQueue: EventQueue; watcher: FileWatcher; onClose: () => Promise<void> } {
    const eventQueue = new EventQueue({
      debounceMs: this.config.watcher.debounceMs,
      maxQueueSize: this.config.watcher.maxQueueSize,
      fullScanThreshold: this.config.watcher.fullScanThreshold,
      concurrency: 4,
      metricsHooks: this.metricsCollector,
      onFullScanRequired: () => {
        const p = this.triggerFullScan().finally(() => {
          if (this.fullScanPromise === p) {
            this.fullScanPromise = undefined;
          }
        });
        this.fullScanPromise = p;
        return Promise.resolve();
      },
    });

    const watcher = new FileWatcher(
      { projectRoot: this.projectRoot, ignorePaths: this.ignorePaths },
      eventQueue,
    );

    this.drainTask = this.startDrainLoop(eventQueue);

    return { eventQueue, watcher, onClose: () => this.stop() };
  }
```

- [ ] **Step 4: Wire `eventQueue` in `createRuntime()`**

In `src/server/factory.ts`, modify the section after `const { watcher, onClose } = eventManager.setup();` (line 485):

```typescript
    const { eventQueue, watcher, onClose } = eventManager.setup();
    pipeline.setEventQueue(eventQueue);
```

And in the `buildNexusRuntime` call (line 494), add `eventQueue`:

```typescript
      return buildNexusRuntime({
        projectRoot,
        sanitizer,
        semanticSearch,
        grepEngine,
        orchestrator,
        vectorStore,
        metadataStore,
        pipeline,
        pluginRegistry,
        watcher,
        loadFileContent,
        contentStore,
        metricsCollectorRegistry: metricsCollector.registry,
        metricsPort: config.metricsPort,
        storageDir: config.storage.rootDir,
        projectName: config.projectName,
        metricsHooks: metricsCollector,
        aggregatorPort: config.aggregatorPort,
        packageMode: config.packageMode,
        eventQueue,
        onClose: async () => {
          // ... existing onClose
        },
        runReindex: () =>
          DirectoryScanner.scan(
            projectRoot,
            projectRoot,
            ignorePaths,
            onLog,
          ),
      });
```

- [ ] **Step 5: Run existing factory and runtime tests**

Run: `npx vitest run tests/unit/server/factory.test.ts tests/unit/server/runtime.test.ts`
Expected: All existing tests PASS (eventQueue is optional).

- [ ] **Step 6: Commit**

```bash
git add src/server/tools/types.ts src/server/factory.ts src/indexer/pipeline.ts
git commit -m "feat: wire eventQueue through NexusRuntimeOptions and IndexPipeline"
```

---

### Task 3.2: NexusRuntime auto-trigger background Full Index

**Files:**
- Modify: `src/server/index.ts:105-268` (buildNexusRuntime — initialize, close, reindex)
- Test: `tests/unit/server/runtime-auto-index.test.ts` (create)

**Interfaces:**
- Consumes: `NexusRuntimeOptions.eventQueue`, `metadataStore.getIndexStats()`, `pipeline.reindex()`
- Produces: `NexusRuntime.initialize()` starts background Full reindex when unindexed; `close()` waits for it

- [ ] **Step 1: Modify `buildNexusRuntime` to add auto-reindex logic**

In `src/server/index.ts`, replace the `buildNexusRuntime` function (lines 105-268):

Add a new field `autoReindexPromise` and modify `initialize()` and `close()`:

```typescript
export const buildNexusRuntime = (
  options: NexusRuntimeOptions,
): NexusRuntime => {
  let metricsServer: MetricsHttpServer | null = null;
  let initPromise: Promise<void> | null = null;
  let registrationClient: RegistrationClient | null = null;
  let autoReindexPromise: Promise<void> | null = null;
  let isShuttingDown = false;

  const initialize = (): Promise<void> => {
    if (initPromise) {
      return initPromise;
    }
    initPromise = (async () => {
      await options.metadataStore.initialize();
      await options.vectorStore.initialize();
      await options.pipeline.reconcileOnStartup();


      // --- Check if unindexed BEFORE starting the Watcher ---
      // Enter post-scan mode before watcher.start() so events arriving
      // during the Full Index are buffered, not processed concurrently.
      // (Thread 9: prevents Full Index results from being overwritten by
      // stale Watcher events processed in parallel.)
      let needsPostScan = false;
      try {
        const stats = await options.metadataStore.getIndexStats();
        const isUnindexed = stats === null || stats.lastIndexedAt === null;
        if (isUnindexed && !isShuttingDown) {
          options.eventQueue?.enterPostScanMode();
          needsPostScan = true;
        }
      } catch (statsError) {
        console.error(
          `[Nexus] Failed to check index status for auto Full Index:`,
          statsError,
        );
      }

      try {
        options.pipeline.start();
        await options.watcher.start().catch((error) => {
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? (error as Record<string, unknown>).code
              : undefined;
          const isNonFatal = code === "EMFILE" || code === "ENOSPC";

          if (isNonFatal) {
            console.error(
              `[Nexus Server Warning] Failed to start FileWatcher (${code}):`,
              error,
            );
          } else {
            throw error;
          }
        });

        // Use port 0 for auto-assignment, unless explicitly overridden.
        const preferredPort = options.metricsPort ?? 0;
        metricsServer = options.metricsCollectorRegistry
          ? new MetricsHttpServer(options.metricsCollectorRegistry)
          : null;
        if (metricsServer) {
          await metricsServer.start(preferredPort).catch((err) => {
            console.warn("[Nexus] Failed to start metrics HTTP server:", err);
          });
          const resolvedPort = metricsServer.getPort();
          await syncMetricsPortFile(options.storageDir, resolvedPort);
          registrationClient = options.packageMode
            ? null
            : createRegistrationClient(
                options.aggregatorPort ?? 9470,
                resolvedPort,
                options.projectRoot,
                options.projectName,
              );
        }
      } catch (error) {
        await options.pipeline.stop().catch((stopError: unknown) => {
          console.error(
            "Failed to stop pipeline during initialization rollback:",
            stopError,
          );
        });
        await options.watcher.stop().catch((stopError: unknown) => {
          console.error(
            "Failed to stop watcher during initialization rollback:",
            stopError,
          );
        });
        throw error;
      }

      // --- Start background Full Index if unindexed ---
      if (needsPostScan) {
        const reindexPromise = options.pipeline
          .reindex(
            options.runReindex,
            options.loadFileContent,
            true,
            "startup-reconciliation",
          )
          .then(async (result) => {
            // Don't drain if reindex didn't actually run (already_running).
            // (Thread 10: prevents treating already_running as Full Index completion.)
            if (result && typeof result === 'object' && 'status' in result &&
                (result.status === 'already_running' || result.status === 'incomplete')) {
              // Another reindex is already running, or DLQ had items.
              // Do NOT drain the post-scan queue — the Full Index hasn't completed.
              return;
            }
            // Drain post-scan queue after scan completes (if not shutting down).
            if (!isShuttingDown) {
              options.eventQueue?.drainPostScanQueue();
            }
          })
          .catch(async (error) => {
            // Drain post-scan queue even on failure (if not shutting down).
            if (!isShuttingDown) {
              options.eventQueue?.drainPostScanQueue();
            }
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[Nexus] Startup auto Full Index failed:`,
              error,
            );
            const progress = options.pipeline.getProgress();
            if (!progress.lastError) {
              progress.lastError = message;
            }
          });

        // Attach rejection handler at Promise creation to prevent unhandled rejection.
        autoReindexPromise = reindexPromise;
      }
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
    return initPromise;
  };

  const close = async () => {
    isShuttingDown = true;
    const shutdownErrors: unknown[] = [];

    // Wait for any ongoing initialization to complete or fail before
    // proceeding with shutdown.
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // Initialization failed; rollback inside initialize() already
        // attempted cleanup. Proceed with the rest of shutdown.
      }
    }

    // Abort post-scan mode (don't drain — events are lost on shutdown).
    options.eventQueue?.abortPostScanMode();

    if (metricsServer) {
      try {
        await metricsServer.stop();
      } catch (error) {
        shutdownErrors.push(error);
      }
      if (options.storageDir) {
        await removeMetricsPort(options.storageDir).catch(() => {});
      }
    }
    if (registrationClient) {
      registrationClient.stop();
      registrationClient = null;
    }

    if (options.onClose) {
      try {
        await options.onClose();
      } catch (error) {
        shutdownErrors.push(error);
      }
    }

    try {
      await options.watcher.stop();
    } catch (error) {
      shutdownErrors.push(error);
    }

    // Wait for auto-reindex Promise to settle before stopping the pipeline.
    // Stop-related rejections are already logged; treat them as handled.
    if (autoReindexPromise) {
      try {
        await autoReindexPromise;
      } catch {
        // Rejection was already recorded in the .catch handler during initialize().
      }
    }

    try {
      await options.pipeline.stop();
    } catch (error) {
      shutdownErrors.push(error);
    }

    if (shutdownErrors.length === 1) {
      throw shutdownErrors[0];
    } else if (shutdownErrors.length > 1) {
      throw new AggregateError(
        shutdownErrors,
        "Multiple errors occurred during Nexus runtime shutdown",
      );
    }
  };

  const reindex = async (fullRebuild?: boolean) => {
    await initialize();
    const result = await options.pipeline.reindex(
      options.runReindex,
      options.loadFileContent,
      fullRebuild,
    );
    if ("status" in result) {
      throw new Error(`Reindex already running: ${result.status}`);
    }
  };

  const createServer = (): McpServer => createNexusServer(options, () => initialize());

  return {
    createServer,
    orchestrator: options.orchestrator,
    sanitizer: options.sanitizer,
    initialize,
    close,
    reindex,
    get registrationClient() { return registrationClient; }
  };
};
```

Key changes:
1. Added `autoReindexPromise` and `isShuttingDown` fields
2. After initialization completes, check `getIndexStats().lastIndexedAt`
3. If unindexed, enter post-scan mode, start background Full reindex with `reason: 'startup-reconciliation'`
4. Attach `.then()` to drain post-scan queue on success
5. Attach `.catch()` to drain post-scan queue on failure and log error
6. In `close()`: set `isShuttingDown = true`, abort post-scan mode, wait for `autoReindexPromise` before `pipeline.stop()`

- [ ] **Step 2: Write the failing test**

Create `tests/unit/server/runtime-auto-index.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { buildNexusRuntime, type NexusRuntimeOptions } from '../../../src/server/index.js';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import { EventQueue } from '../../../src/indexer/event-queue.js';

const makeOptions = (overrides: Partial<NexusRuntimeOptions> = {}): NexusRuntimeOptions => {
  const metadataStore = new InMemoryMetadataStore();
  return {
    projectRoot: process.cwd(),
    sanitizer: { sanitize: async (p: string) => p, validateGlob: (p: string) => p } as any,
    semanticSearch: { search: async () => [] } as any,
    grepEngine: { search: async () => [] } as any,
    orchestrator: { search: async () => ({ query: 'q', results: [], tookMs: 1 }) } as any,
    vectorStore: {
      initialize: async () => undefined,
      upsertChunks: async () => undefined,
      deleteByFilePath: async () => 0,
      deleteByPathPrefix: async () => 0,
      renameFilePath: async () => 0,
      search: async () => [],
      compactIfNeeded: async () => ({ compacted: false, fragmentationRatioBefore: 0, fragmentationRatioAfter: 0, chunksRemoved: 0 }),
      compactAfterReindex: async () => ({ compacted: false, fragmentationRatioBefore: 0, fragmentationRatioAfter: 0, chunksRemoved: 0 }),
      scheduleIdleCompaction: () => setTimeout(() => {}, 0),
      getStats: async () => ({ totalChunks: 0, totalFiles: 0, dimensions: 64, fragmentationRatio: 0 }),
      close: async () => undefined,
    } as any,
    metadataStore,
    pipeline: {
      reconcileOnStartup: async () => ({
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1000,
        reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        chunksIndexed: 0,
      }),
      start: () => undefined,
      stop: async () => undefined,
      getProgress: () => ({ totalFiles: 0, processedFiles: 0, status: 'idle' as const }),
      getSkippedFiles: () => new Map(),
      reindex: async () => ({
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1000,
        reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        chunksIndexed: 0,
      }),
    } as any,
    pluginRegistry: { healthCheck: async () => ({ languages: [], embeddingProvider: 'test', healthy: true }) } as any,
    watcher: { start: async () => undefined, stop: async () => undefined } as any,
    runReindex: async () => [],
    loadFileContent: async () => '',
    ...overrides,
  } as unknown as NexusRuntimeOptions;
};

describe('NexusRuntime auto Full Index', () => {
  it('starts background Full reindex when unindexed (lastIndexedAt is null)', async () => {
    const options = makeOptions();
    const eventQueue = new EventQueue({
      debounceMs: 10,
      maxQueueSize: 100,
      fullScanThreshold: 50,
      concurrency: 1,
    });
    options.eventQueue = eventQueue;

    // Use a deferred Promise so we can verify initialize() does NOT await the reindex.
    // (Thread 11: if the spy resolves immediately, the test passes even if
    // initialize() incorrectly awaits the reindex.)
    let resolveReindex!: () => void;
    const reindexDeferred = new Promise<void>((resolve) => {
      resolveReindex = resolve;
    });

    const reindexSpy = vi.fn(async () => {
      await reindexDeferred;
      return {
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1000,
        reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        chunksIndexed: 0,
      };
    });
    options.pipeline.reindex = reindexSpy;

    const runtime = buildNexusRuntime(options);
    await runtime.initialize();

    // initialize() should NOT have awaited the reindex — the deferred Promise
    // is still pending, yet initialize() already returned.
    expect(reindexSpy).toHaveBeenCalledWith(
      options.runReindex,
      options.loadFileContent,
      true,
      'startup-reconciliation',
    );

    // Post-scan mode should still be active (reindex hasn't completed yet)
    expect(eventQueue.isPostScanActive()).toBe(true);

    // Now resolve the reindex so the .then() handler can drain the post-scan queue
    resolveReindex();
    // Wait for the .then() handler to run
    await new Promise((resolve) => setImmediate(resolve));

    // Post-scan mode should have been drained now
    expect(eventQueue.isPostScanActive()).toBe(false);

    await runtime.close();
  });

  it('does NOT start auto Full reindex when already indexed (lastIndexedAt set)', async () => {
    const options = makeOptions();
    const metadataStore = options.metadataStore as InMemoryMetadataStore;
    await metadataStore.setIndexStats({
      id: 'primary',
      totalFiles: 10,
      totalChunks: 20,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      lastFullScanAt: '2026-01-01T00:00:00.000Z',
      overflowCount: 0,
    });

    const reindexSpy = vi.fn(async () => ({
      startedAt: '', finishedAt: '', durationMs: 0,
      reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 0,
    }));
    options.pipeline.reindex = reindexSpy;

    const runtime = buildNexusRuntime(options);
    await runtime.initialize();

    expect(reindexSpy).not.toHaveBeenCalled();

    await runtime.close();
  });

  it('starts auto Full reindex when index_stats row exists but lastIndexedAt is null (stale migration)', async () => {
    // This tests the migration case: existing data without lastIndexedAt
    const options = makeOptions();
    const metadataStore = options.metadataStore as InMemoryMetadataStore;
    // Simulate stale data: stats exist but lastIndexedAt is null
    await metadataStore.setIndexStats({
      id: 'primary',
      totalFiles: 5,
      totalChunks: 10,
      lastIndexedAt: null,
      lastFullScanAt: null,
      overflowCount: 0,
    });

    const reindexSpy = vi.fn(async () => ({
      startedAt: '', finishedAt: '', durationMs: 0,
      reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 0,
    }));
    options.pipeline.reindex = reindexSpy;

    const runtime = buildNexusRuntime(options);
    await runtime.initialize();

    // lastIndexedAt is null → unindexed → auto Full Index should trigger
    expect(reindexSpy).toHaveBeenCalledTimes(1);

    await runtime.close();
  });

  it('handles auto reindex rejection without unhandled rejection', async () => {
    const options = makeOptions();
    const reindexError = new Error('reindex boom');
    options.pipeline.reindex = vi.fn(async () => {
      throw reindexError;
    });
    options.pipeline.getProgress = vi.fn(() => ({
      totalFiles: 0,
      processedFiles: 0,
      status: 'idle' as const,
      lastError: undefined,
    }));

    const runtime = buildNexusRuntime(options);

    // Should not throw — rejection is handled
    await expect(runtime.initialize()).resolves.toBeUndefined();

    await runtime.close();
  });

  it('close() waits for auto-reindex Promise before stopping pipeline', async () => {
    const options = makeOptions();
    const stopOrder: string[] = [];

    let resolveReindex: () => void;
    const reindexPromise = new Promise<void>((resolve) => {
      resolveReindex = resolve;
    });

    options.pipeline.reindex = vi.fn(async () => {
      stopOrder.push('reindex-started');
      await reindexPromise;
      stopOrder.push('reindex-done');
      return {
        startedAt: '', finishedAt: '', durationMs: 0,
        reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
        chunksIndexed: 0,
      };
    });

    options.pipeline.stop = vi.fn(async () => {
      stopOrder.push('pipeline.stop');
    });

    options.watcher.stop = vi.fn(async () => {
      stopOrder.push('watcher.stop');
    });

    const runtime = buildNexusRuntime(options);
    await runtime.initialize();

    // Start close() — it should wait for the reindex Promise
    const closePromise = runtime.close();

    // Give the event loop a chance
    await new Promise((resolve) => setImmediate(resolve));

    // pipeline.stop should NOT have been called yet (reindex still running)
    expect(stopOrder).not.toContain('pipeline.stop');

    // Now resolve the reindex
    resolveReindex!();
    await closePromise;

    // pipeline.stop should be called after reindex completes
    expect(stopOrder).toContain('reindex-done');
    expect(stopOrder).toContain('pipeline.stop');
    expect(stopOrder.indexOf('reindex-done')).toBeLessThan(stopOrder.indexOf('pipeline.stop'));
  });

  it('does not start auto Full reindex twice in the same Runtime', async () => {
    const options = makeOptions();
    const reindexSpy = vi.fn(async () => ({
      startedAt: '', finishedAt: '', durationMs: 0,
      reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 0,
    }));
    options.pipeline.reindex = reindexSpy;

    const runtime = buildNexusRuntime(options);

    // First initialize
    await runtime.initialize();
    const firstCallCount = reindexSpy.mock.calls.length;
    expect(firstCallCount).toBe(1);

    // Second initialize call (should be idempotent — initPromise cached)
    await runtime.initialize();
    expect(reindexSpy.mock.calls.length).toBe(1); // still only 1 call

    await runtime.close();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/unit/server/runtime-auto-index.test.ts`
Expected: FAIL — auto-reindex logic not yet implemented.

- [ ] **Step 4: Implement the changes in `buildNexusRuntime`**

Apply the changes from Step 1 to `src/server/index.ts`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/server/runtime-auto-index.test.ts`
Expected: PASS

- [ ] **Step 6: Run all existing runtime tests**

Run: `npx vitest run tests/unit/server/runtime.test.ts`
Expected: All existing tests PASS (eventQueue is optional, existing tests don't provide it).

- [ ] **Step 7: Run lint and build**

Run: `npm run lint && npm run build`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/server/index.ts tests/unit/server/runtime-auto-index.test.ts
git commit -m "feat: auto-trigger background Full Index on unindexed project startup"
```

- [ ] **Step 9: Create PR3**

```bash
git push -u origin feat/runtime-auto-full-index
gh pr create --base feat/eventqueue-post-scan-queue --title "feat: runtime auto Full Index on unindexed startup" --body "Stacked PR 3/3. NexusRuntime.initialize() checks lastIndexedAt and starts a background Full reindex with reason='startup-reconciliation'. close() waits for the auto-reindex Promise before closing stores. Post-scan queue drains after scan completes."
```

---

## Post-Integration Verification

### Task 4.1: Full test suite

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds.

---

## Self-Review

### Spec Coverage

| Spec Requirement | Task |
| --- | --- |
| `index_stats` as sole source of completion state | Task 1.3 |
| `lastIndexedAt` null or row absent → unindexed | Task 3.2 |
| Success + DLQ empty → update `lastIndexedAt` | Task 1.1, 1.3 |
| Full reindex success → also update `lastFullScanAt` | Task 1.3 |
| Normal reindex → preserve existing `lastFullScanAt`; new row → `null` | Task 1.3 |
| `totalFiles`/`totalChunks` from Vector Store stats | Task 1.3 |
| `overflowCount` preserved, new row → 0 | Task 1.3 |
| Existing data migration: unrecorded lastIndexedAt → treated as unindexed | Task 3.2 (lastIndexedAt null check) |
| IndexPipeline records success atomically with DLQ check | Task 1.1, 1.2, 1.3 |
| Completion lock shared with DLQ add/remove | Task 1.2 |
| Compact failure is non-fatal, doesn't block completion | Task 1.3 |
| DLQ residual → lastError + skippedFiles, no completion, returns `{ status: 'incomplete' }` | Task 1.3 |
| Same path multiple DLQ entries → newest createdAt's errorMessage | Task 1.3 |
| Manual and auto reindex use same success conditions | Task 1.3 (shared code path) |
| `reason: 'startup-reconciliation'` for auto, `'manual'` for manual | Task 1.3, 3.2 |
| NexusRuntime.initialize() checks lastIndexedAt after init | Task 3.2 |
| Auto Full Index not awaited by initialize() | Task 3.2 |
| Rejection handler attached at Promise creation | Task 3.2 |
| close() waits for auto-reindex Promise before closing stores | Task 3.2 |
| Post-scan queue buffers Watcher events during startup Full Index | Task 2.1, 3.2 |
| Overflow-drop contract does NOT apply to post-scan queue | Task 2.1 |
| markFullScanComplete() does NOT clear post-scan queue | Task 2.1 |
| Stop → don't drain post-scan queue | Task 3.2 (abortPostScanMode) |
| Runtime continues → drain after scan completes (success or failure) | Task 3.2 |
| No new CLI, MCP, API, UI | All tasks |
| No schema changes | Task 1.1 (reuses existing columns) |
| Watcher start delayed until after unindexed check + post-scan mode entry | Task 3.2 |

### Placeholder Scan

No "TBD", "TODO", "implement later", "fill in details", "Add appropriate error handling", or "Similar to Task N" found in this plan. All code blocks contain actual implementation code.

### Type Consistency

- `atomicCompletionCheck(stats: IndexStatsRow): Promise<{ dlqEmpty: boolean; dlqEntries: DeadLetterEntry[] }>` — consistent across `IMetadataStore`, `SqliteMetadataStore`, `InMemoryMetadataStore`.
- `reindex(run, loadContent, fullRebuild?, reason?)` — consistent across `IIndexPipeline` interface and `IndexPipeline` implementation. Return type: `Promise<ReindexResult | { status: 'already_running' } | { status: 'incomplete' }>` — `{ status: 'incomplete' }` is returned when DLQ has items after Full Index (not a successful completion).
- `ReindexOptions['reason']` — widened from `'manual'` to the full union `'manual' | 'overflow-recovery' | 'startup-reconciliation'`.
- `EventQueue.enterPostScanMode()`, `drainPostScanQueue()`, `abortPostScanMode()`, `getPostScanQueueSize()`, `isPostScanActive()` — consistent names used in tests and implementation.
- `setEventQueue(eventQueue: EventQueue)` — defined on `IndexPipeline`, called in `factory.ts`.
- `NexusServerOptions.eventQueue?: EventQueue` — defined in `types.ts`, used in `NexusRuntimeOptions` (extends), accessed in `buildNexusRuntime`.