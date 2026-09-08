import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mutex } from 'async-mutex';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { DeadLetterEntry, IndexStatsRow, MerkleNodeRow } from '../../../src/types/index.js';
import { Chunker } from '../../../src/indexer/chunker.js';
import { DeadLetterQueue } from '../../../src/indexer/dead-letter-queue.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { SqliteMetadataStore } from '../../../src/storage/metadata-store.js';
import type { Database } from 'better-sqlite3';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import { InMemoryVectorStore } from './in-memory-vector-store.js';
import { InMemoryMetadataStore } from './in-memory-metadata-store.js';
import type { StructuredImport } from '../../../src/structured/contracts.js';

const makeNode = (overrides: Partial<MerkleNodeRow>): MerkleNodeRow => ({
  path: overrides.path ?? 'src/index.ts',
  hash: overrides.hash ?? 'hash',
  parentPath: overrides.parentPath ?? 'src',
  isDirectory: overrides.isDirectory ?? false,
});

it('exposes active generation imports through the test-only helper', async () => {
  const store = new InMemoryMetadataStore();
  await store.initialize();
  await store.bootstrapStructuredSchema();
  await store.incrementRebuildEpoch();
  const generationId = 'test-generation';
  const importRecord: StructuredImport = {
    id: 'import-1',
    moduleSpecifier: './dependency.js',
    bindingName: 'dependency',
    startByte: 0,
    endByte: 1,
    sourceHash: 'hash',
    completeness: 'complete',
    position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
  };
  await store.stageGeneration({
    filePath: 'src/example.mjs',
    generation: {
      generationId,
      schemaVersion: 1,
      parserId: 'typescript',
      parserVersion: '5.9.3',
      fileHash: 'hash',
      fileCompleteness: 'complete',
    },
    declarations: [],
    imports: [importRecord],
    rebuildEpoch: 1,
    bytes: new Uint8Array([0]),
    fileHash: 'hash',
    fileCompleteness: 'complete',
  });
  await store.activateGeneration({
    filePath: 'src/example.mjs',
    generationId,
    expectedActiveGeneration: null,
    expectedRebuildEpoch: 1,
  });

  expect(store.getActiveImportsForFile('src/example.mjs')).toEqual([
    expect.objectContaining({ moduleSpecifier: './dependency.js', bindingName: 'dependency' }),
  ]);
});

const makeDeadLetterEntry = (overrides: Partial<DeadLetterEntry>): DeadLetterEntry => ({
  id: overrides.id ?? 'dlq-1',
  filePath: overrides.filePath ?? '/repo/src/auth.ts',
  contentHash: overrides.contentHash ?? 'hash-1',
  errorMessage: overrides.errorMessage ?? 'embed failed',
  attempts: overrides.attempts ?? 3,
  recoveryAttempts: overrides.recoveryAttempts ?? 0,
  createdAt: overrides.createdAt ?? '2026-04-07T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-04-07T00:00:00.000Z',
  lastRetryAt: overrides.lastRetryAt ?? null,
});

describe('SqliteMetadataStore', () => {
  let tempDir: string;
  let store: SqliteMetadataStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-metadata-store-'));
    store = new SqliteMetadataStore({
      databasePath: path.join(tempDir, 'metadata.db'),
      batchSize: 100,
    });

    await store.initialize();
  });

  afterEach(async () => {
    try {
      if (store) await store.close();
    } catch {
      // ignore
    }
    try {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('bulkUpsertMerkleNodes stores and returns file nodes', async () => {
    await store.bulkUpsertMerkleNodes([
      makeNode({ path: 'src', hash: 'dir-hash', parentPath: null, isDirectory: true }),
      makeNode({ path: 'src/index.ts', hash: 'file-hash-1' }),
      makeNode({ path: 'src/lib.ts', hash: 'file-hash-2' }),
    ]);

    await expect(store.getMerkleNode('src/index.ts')).resolves.toEqual(
      makeNode({ path: 'src/index.ts', hash: 'file-hash-1' }),
    );

    await expect(store.getAllFileNodes()).resolves.toEqual([
      makeNode({ path: 'src/index.ts', hash: 'file-hash-1' }),
      makeNode({ path: 'src/lib.ts', hash: 'file-hash-2' }),
    ]);
  });

  it('bulkDeleteMerkleNodes removes only targeted paths', async () => {
    await store.bulkUpsertMerkleNodes([
      makeNode({ path: 'src/index.ts', hash: 'file-hash-1' }),
      makeNode({ path: 'src/lib.ts', hash: 'file-hash-2' }),
    ]);

    await store.bulkDeleteMerkleNodes(['src/index.ts']);

    await expect(store.getMerkleNode('src/index.ts')).resolves.toBeNull();
    await expect(store.getMerkleNode('src/lib.ts')).resolves.toEqual(
      makeNode({ path: 'src/lib.ts', hash: 'file-hash-2' }),
    );
  });

  it('deleteSubtree removes descendants under the prefix', async () => {
    await store.bulkUpsertMerkleNodes([
      makeNode({ path: 'src', hash: 'dir-hash', parentPath: null, isDirectory: true }),
      makeNode({ path: 'src/index.ts', hash: 'file-hash-1' }),
      makeNode({ path: 'src/nested', hash: 'nested-hash', parentPath: 'src', isDirectory: true }),
      makeNode({ path: 'src/nested/deep.ts', hash: 'file-hash-2', parentPath: 'src/nested' }),
      makeNode({ path: 'tests/app.test.ts', hash: 'test-hash', parentPath: 'tests' }),
    ]);

    await expect(store.deleteSubtree('src')).resolves.toBe(4);
    await expect(store.getAllPaths()).resolves.toEqual(['tests/app.test.ts']);
  });

  it('splits batch writes at the configured boundary', async () => {
    const nodes = Array.from({ length: 101 }, (_, index) =>
      makeNode({
        path: `src/file-${index}.ts`,
        hash: `hash-${index}`,
      }),
    );

    await store.bulkUpsertMerkleNodes(nodes);

    await expect(store.getAllFileNodes()).resolves.toHaveLength(101);
  });

  it('persists index stats and exposes WAL autocheckpoint setting', async () => {
    const stats: IndexStatsRow = {
      id: 'primary',
      totalFiles: 3,
      totalChunks: 12,
      lastIndexedAt: '2026-04-05T10:00:00.000Z',
      lastFullScanAt: '2026-04-05T09:00:00.000Z',
      overflowCount: 1,
      lastError: null,
    };

    await store.setIndexStats(stats);

    await expect(store.getIndexStats()).resolves.toEqual(stats);
    expect(store.getPragmaValue('wal_autocheckpoint') as number).toBe(1000);
  });

  it('writes index stats when atomic completion sees an empty DLQ', async () => {
    const stats: IndexStatsRow = {
      id: 'primary',
      totalFiles: 10,
      totalChunks: 20,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      lastFullScanAt: '2026-01-01T00:00:00.000Z',
      overflowCount: 0,
      lastError: null,
    };

    await expect(store.atomicCompletionCheck(stats)).resolves.toEqual({
      dlqEmpty: true,
      dlqEntries: [],
    });
    await expect(store.getIndexStats()).resolves.toEqual(stats);
  });

  it('does not write index stats when atomic completion sees DLQ entries', async () => {
    const entry = makeDeadLetterEntry({ filePath: 'failed.ts' });
    await store.upsertDeadLetterEntries([entry]);
    const stats: IndexStatsRow = {
      id: 'primary',
      totalFiles: 10,
      totalChunks: 20,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      lastFullScanAt: '2026-01-01T00:00:00.000Z',
      overflowCount: 0,
      lastError: null,
    };

    const result = await store.atomicCompletionCheck(stats);

    expect(result.dlqEmpty).toBe(false);
    expect(result.dlqEntries).toEqual([entry]);
    await expect(store.getIndexStats()).resolves.toMatchObject({ id: 'primary' });
  });

  it('serializes DLQ updates with the atomic completion check lock', async () => {
    const completionLock = new Mutex();
    const queue = new DeadLetterQueue({ metadataStore: store, completionLock });
    await queue.load();
    const release = await completionLock.acquire();
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        release();
      }
    };

    const enqueuePromise = queue.enqueue({
      filePath: 'concurrent.ts',
      contentHash: 'hash',
      errorMessage: 'error',
      attempts: 1,
    });

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(store.getDeadLetterEntries()).resolves.toHaveLength(0);
      await expect(
        store.atomicCompletionCheck({
          id: 'primary',
          totalFiles: 0,
          totalChunks: 0,
          lastIndexedAt: '2026-01-01T00:00:00.000Z',
          lastFullScanAt: null,
          overflowCount: 0,
          lastError: null,
        }),
      ).resolves.toMatchObject({ dlqEmpty: true });
    } finally {
      releaseOnce();
    }

    await expect(enqueuePromise).resolves.toMatchObject({ filePath: 'concurrent.ts' });
    await expect(store.getDeadLetterEntries()).resolves.toHaveLength(1);
  });

  it('detects a contended DLQ enqueue through IndexPipeline.reindex', async () => {
    const completionLock = new Mutex();
    const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
    await vectorStore.initialize();
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.registerLanguage(new TypeScriptLanguagePlugin());
    const pipeline = new IndexPipeline({
      metadataStore: store,
      vectorStore,
      chunker: new Chunker(pluginRegistry),
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry,
      completionLock,
    });
    const queue = new DeadLetterQueue({ metadataStore: store, completionLock });
    await queue.load();

    const completionResults: Array<{
      dlqEmpty: boolean;
      dlqEntries: DeadLetterEntry[];
    }> = [];
    const atomicCompletionCheck = store.atomicCompletionCheck.bind(store);
    vi.spyOn(store, 'atomicCompletionCheck').mockImplementation(async (stats) => {
      const result = await atomicCompletionCheck(stats);
      completionResults.push(result);
      return result;
    });

    const release = await completionLock.acquire();
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        release();
      }
    };

    const enqueuePromise = queue.enqueue({
      filePath: 'pipeline-concurrent.ts',
      contentHash: 'hash',
      errorMessage: 'pipeline error',
      attempts: 1,
    });
    const reindexPromise = pipeline.reindex(async () => [], async () => '', true, 'overflow-recovery');

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(store.getDeadLetterEntries()).resolves.toHaveLength(0);

      releaseOnce();
      const entry = await enqueuePromise;
      const result = await reindexPromise;

      expect(result).toEqual({ status: 'incomplete' });
      expect(completionResults).toHaveLength(1);
      expect(completionResults[0]?.dlqEmpty).toBe(false);
      expect(completionResults[0]?.dlqEntries).toEqual([entry]);
      await expect(store.getDeadLetterEntries()).resolves.toEqual([entry]);
      await expect(store.getIndexStats()).resolves.toMatchObject({
        lastIndexedAt: null,
        lastError: 'Full reindex incomplete: 1 dead-letter queue item(s) remain',
      });
    } finally {
      releaseOnce();
      await Promise.allSettled([enqueuePromise, reindexPromise]);
      await vectorStore.close();
    }
  });

  it('stores, updates, and removes dead letter entries', async () => {
    const first = makeDeadLetterEntry({ id: 'dlq-1' });
    const second = makeDeadLetterEntry({ id: 'dlq-2', filePath: '/repo/src/other.ts', contentHash: 'hash-2' });

    await store.upsertDeadLetterEntries([first, second]);
    await expect(store.getDeadLetterEntries()).resolves.toEqual([first, second]);

    const updated = makeDeadLetterEntry({
      id: 'dlq-1',
      errorMessage: 'embed failed again',
      attempts: 4,
      updatedAt: '2026-04-07T00:01:00.000Z',
      lastRetryAt: '2026-04-07T00:01:00.000Z',
    });
    await store.upsertDeadLetterEntries([updated]);
    await store.removeDeadLetterEntries(['dlq-2']);

    await expect(store.getDeadLetterEntries()).resolves.toEqual([updated]);
  });

  it('renamePath preserves the isDirectory property of the node', async () => {
    // 1. Rename a file
    await store.bulkUpsertMerkleNodes([
      makeNode({ path: 'src/old.ts', hash: 'h1', isDirectory: false }),
    ]);
    await store.renamePath('src/old.ts', 'src/new.ts', 'h1-updated');
    const fileNode = await store.getMerkleNode('src/new.ts');
    expect(fileNode?.isDirectory).toBe(false);
    expect(fileNode?.hash).toBe('h1-updated');
    await expect(store.getMerkleNode('src/old.ts')).resolves.toBeNull();

    // 2. Rename a directory
    await store.bulkUpsertMerkleNodes([
      makeNode({ path: 'old-dir', hash: 'd1', parentPath: null, isDirectory: true }),
    ]);
    await store.renamePath('old-dir', 'new-dir', 'd1-updated');
    const dirNode = await store.getMerkleNode('new-dir');
    expect(dirNode?.isDirectory).toBe(true);
    expect(dirNode?.hash).toBe('d1-updated');
    await expect(store.getMerkleNode('old-dir')).resolves.toBeNull();
  });

  it('renamePath handles non-existent source paths by creating a new node', async () => {
    // 1. Rename a non-existent path
    await store.renamePath('nonexistent/path.ts', 'new/path.ts', 'h1');
    const node = await store.getMerkleNode('new/path.ts');
    expect(node?.isDirectory).toBe(false);
    expect(node?.hash).toBe('h1');
    await expect(store.getMerkleNode('nonexistent/path.ts')).resolves.toBeNull();
  });


  describe('embedding cache', () => {
    it('stores and retrieves embeddings by hash', async () => {
      await store.setEmbeddings([
        { hash: 'hash-a', vector: [0.1, 0.2, 0.3] },
        { hash: 'hash-b', vector: [0.4, 0.5, 0.6] },
      ]);

      const result = await store.getEmbeddings(['hash-a', 'hash-b']);
      expect(result.get('hash-a')).toEqual([0.1, 0.2, 0.3]);
      expect(result.get('hash-b')).toEqual([0.4, 0.5, 0.6]);
    });

    it('returns only existing embeddings', async () => {
      await store.setEmbeddings([{ hash: 'hash-a', vector: [0.1, 0.2, 0.3] }]);

      const result = await store.getEmbeddings(['hash-a', 'missing']);
      expect(result.has('hash-a')).toBe(true);
      expect(result.has('missing')).toBe(false);
    });

    it('updates an existing embedding', async () => {
      await store.setEmbeddings([{ hash: 'hash-a', vector: [0.1, 0.2, 0.3] }]);
      await store.setEmbeddings([{ hash: 'hash-a', vector: [0.9, 0.8, 0.7] }]);

      const result = await store.getEmbeddings(['hash-a']);
      expect(result.get('hash-a')).toEqual([0.9, 0.8, 0.7]);
    });

    it('deletes specific embeddings', async () => {
      await store.setEmbeddings([
        { hash: 'hash-a', vector: [0.1, 0.2, 0.3] },
        { hash: 'hash-b', vector: [0.4, 0.5, 0.6] },
      ]);

      await store.deleteEmbeddings(['hash-a']);
      const result = await store.getEmbeddings(['hash-a', 'hash-b']);
      expect(result.has('hash-a')).toBe(false);
      expect(result.has('hash-b')).toBe(true);
    });

    it('clears all embeddings', async () => {
      await store.setEmbeddings([
        { hash: 'hash-a', vector: [0.1, 0.2, 0.3] },
        { hash: 'hash-b', vector: [0.4, 0.5, 0.6] },
      ]);

      await store.clearEmbeddings();
      const result = await store.getEmbeddings(['hash-a', 'hash-b']);
      expect(result.size).toBe(0);
    });

    it('handles batches larger than the SQLite variable limit (999)', async () => {
      const entries = Array.from({ length: 1200 }, (_, i) => ({
        hash: `hash-${i}`,
        vector: [0.1, 0.2, 0.3],
      }));
      await store.setEmbeddings(entries);

      const hashes = entries.map((e) => e.hash);
      const result = await store.getEmbeddings(hashes);
      expect(result.size).toBe(1200);
      expect(result.get('hash-0')).toEqual([0.1, 0.2, 0.3]);
      expect(result.get('hash-1199')).toEqual([0.1, 0.2, 0.3]);
    });

    it('gracefully skips corrupted JSON cache entries', async () => {
      await store.setEmbeddings([
        { hash: 'hash-valid', vector: [0.1, 0.2, 0.3] },
      ]);
      // Manually corrupt the stored JSON
      const db = (store as unknown as { db: Database }).db;
      db.prepare(`UPDATE embedding_cache SET vector = 'invalid-json' WHERE hash = 'hash-valid'`).run();

      const result = await store.getEmbeddings(['hash-valid']);
      expect(result.size).toBe(0);
    });

    it('prunes embeddings older than maxAgeDays', async () => {
      await store.setEmbeddings([
        { hash: 'hash-old', vector: [0.1, 0.2, 0.3] },
      ]);
      // Manually update created_at to an old date to simulate age
      const db = (store as unknown as { db: Database }).db;
      db.prepare(`UPDATE embedding_cache SET created_at = date('now', '-10 days') WHERE hash = 'hash-old'`).run();

      const pruned = await store.pruneEmbeddings(7);
      expect(pruned).toBe(1);

      const remaining = await store.getEmbeddings(['hash-old']);
      expect(remaining.size).toBe(0);
    });
  });
});
