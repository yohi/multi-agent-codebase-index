import { describe, expect, it } from 'vitest';

import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import type { CompactionResult, IndexEvent, ReindexOptions } from '../../../src/types/index.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import { createPipeline } from '../../shared/test-helpers.js';
import { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';

class CompactionFailingVectorStore extends InMemoryVectorStore {
  override async compactAfterReindex(): Promise<CompactionResult> {
    throw new Error('compact failed');
  }
}

const makePipeline = async () => {
  const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker,
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: registry,
  });
  return { pipeline, metadataStore, vectorStore };
};

const makeDlqEntry = (overrides: Partial<IndexEvent> & { id: string; errorMessage: string; createdAt: string }) => ({
  id: overrides.id,
  filePath: overrides.filePath ?? 'failed.ts',
  contentHash: overrides.contentHash ?? 'hash',
  errorMessage: overrides.errorMessage,
  attempts: 1,
  recoveryAttempts: 0,
  createdAt: overrides.createdAt,
  updatedAt: overrides.createdAt,
  lastRetryAt: null,
});

const scanNoFiles = async (_options?: { fullScan?: boolean; reason?: ReindexOptions['reason'] }): Promise<IndexEvent[]> => [];
const loadContent = async (_filePath: string): Promise<string> => '';

describe('IndexPipeline completion recording', () => {
  it('records both index timestamps after a successful full reindex', async () => {
    const { pipeline, metadataStore } = await makePipeline();

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    const stats = await metadataStore.getIndexStats();
    expect(stats).not.toBeNull();
    expect(stats?.lastIndexedAt).not.toBeNull();
    expect(stats?.lastFullScanAt).not.toBeNull();
  });

  it('preserves lastFullScanAt during a successful normal reindex', async () => {
    const { pipeline, metadataStore } = await makePipeline();

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');
    const fullScanAt = (await metadataStore.getIndexStats())?.lastFullScanAt;
    await pipeline.reindex(scanNoFiles, loadContent, false, 'manual');

    expect((await metadataStore.getIndexStats())?.lastFullScanAt).toBe(fullScanAt);
  });

  it('leaves lastFullScanAt null for a first normal reindex', async () => {
    const { pipeline, metadataStore } = await makePipeline();

    await pipeline.reindex(scanNoFiles, loadContent, false, 'manual');

    const stats = await metadataStore.getIndexStats();
    expect(stats?.lastIndexedAt).not.toBeNull();
    expect(stats?.lastFullScanAt).toBeNull();
  });

  it('returns incomplete and skips completion recording when DLQ entries remain', async () => {
    const { pipeline, metadataStore } = await makePipeline();
    await metadataStore.upsertDeadLetterEntries([
      makeDlqEntry({ id: 'dlq-1', errorMessage: 'embed failed', createdAt: '2026-08-20T00:00:00.000Z' }),
    ]);

    const result = await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    expect(result).toEqual({ status: 'incomplete' });
    expect(await metadataStore.getIndexStats()).toBeNull();
    expect(pipeline.getProgress().lastError).toBe(
      'Full reindex incomplete: 1 dead-letter queue item(s) remain',
    );
    expect(pipeline.getSkippedFiles().get('failed.ts')).toBe('embed failed');
  });

  it('does not record completion when scanning throws', async () => {
    const { pipeline, metadataStore } = await makePipeline();

    await expect(
      pipeline.reindex(async () => {
        throw new Error('scan failed');
      }, loadContent, true, 'manual'),
    ).rejects.toThrow('scan failed');

    expect(await metadataStore.getIndexStats()).toBeNull();
  });

  it('records completion when compaction fails', async () => {
    const { metadataStore, chunker, registry } = await createPipeline();
    const vectorStore = new CompactionFailingVectorStore({ dimensions: 64 });
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: registry,
    });

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    expect((await metadataStore.getIndexStats())?.lastIndexedAt).not.toBeNull();
  });

  it('uses the newest DLQ error for duplicate file paths', async () => {
    const { pipeline, metadataStore } = await makePipeline();
    await metadataStore.upsertDeadLetterEntries([
      makeDlqEntry({
        id: 'dlq-old',
        filePath: 'shared.ts',
        errorMessage: 'old error',
        createdAt: '2026-08-20T00:00:00.000Z',
      }),
      makeDlqEntry({
        id: 'dlq-new',
        filePath: 'shared.ts',
        errorMessage: 'new error',
        createdAt: '2026-08-20T00:00:01.000Z',
      }),
    ]);

    await pipeline.reindex(scanNoFiles, loadContent, true, 'manual');

    expect(pipeline.getSkippedFiles().get('shared.ts')).toBe('new error');
  });

  it('passes the reindex reason to the scan callback', async () => {
    const { pipeline } = await makePipeline();
    let receivedReason: ReindexOptions['reason'];

    await pipeline.reindex(async (options) => {
      receivedReason = options?.reason;
      return [];
    }, loadContent, true, 'startup-reconciliation');

    expect(receivedReason).toBe('startup-reconciliation');
  });
});
