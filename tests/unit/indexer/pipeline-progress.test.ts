import { describe, expect, it, vi } from 'vitest';

import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { createPipeline } from '../../shared/test-helpers.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';

function createPipelineWithProgressSpy() {
  return createPipeline().then(async (deps) => {
    const onIndexingProgress = vi.fn();
    const pipeline = new IndexPipeline({
      metadataStore: deps.metadataStore,
      vectorStore: deps.vectorStore,
      chunker: deps.chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: deps.registry,
      metricsHooks: {
        onChunksIndexed: vi.fn(),
        onDlqSnapshot: vi.fn(),
        onReindexComplete: vi.fn(),
        onRecoverySweepComplete: vi.fn(),
        onIndexingProgress,
      },
    });
    return { pipeline, onIndexingProgress };
  });
}

describe('IndexPipeline progress metrics', () => {
  it('sets totalFiles to the current batch size when processEvents is called directly', async () => {
    const { pipeline, onIndexingProgress } = await createPipelineWithProgressSpy();

    await pipeline.processEvents([
      { type: 'deleted', filePath: 'src/a.ts', detectedAt: new Date().toISOString() },
      { type: 'deleted', filePath: 'src/b.ts', detectedAt: new Date().toISOString() },
    ]);

    const lastCall = onIndexingProgress.mock.calls.at(-1);
    expect(lastCall).toEqual([2, 2, false]);
  });

  it('reports active=false after a direct processEvents call finishes', async () => {
    const { pipeline, onIndexingProgress } = await createPipelineWithProgressSpy();

    await pipeline.processEvents([
      { type: 'deleted', filePath: 'src/a.ts', detectedAt: new Date().toISOString() },
    ]);

    const activeFlags = onIndexingProgress.mock.calls.map((call) => call[2]);
    expect(activeFlags.at(-1)).toBe(false);
    expect(activeFlags).toContain(true);
  });

  it('sets totalFiles on subsequent processEvents calls after the tree is already loaded', async () => {
    const { pipeline, onIndexingProgress } = await createPipelineWithProgressSpy();

    // First call loads the Merkle tree.
    await pipeline.processEvents([
      { type: 'deleted', filePath: 'src/a.ts', detectedAt: new Date().toISOString() },
    ]);
    onIndexingProgress.mockClear();

    // Second call must still update totalFiles for the new batch.
    await pipeline.processEvents([
      { type: 'deleted', filePath: 'src/b.ts', detectedAt: new Date().toISOString() },
      { type: 'deleted', filePath: 'src/c.ts', detectedAt: new Date().toISOString() },
      { type: 'deleted', filePath: 'src/d.ts', detectedAt: new Date().toISOString() },
    ]);

    const lastCall = onIndexingProgress.mock.calls.at(-1);
    // processedFiles accumulates across incremental batches; totalFiles is reset per batch.
    expect(lastCall).toEqual([4, 3, false]);
  });
});
