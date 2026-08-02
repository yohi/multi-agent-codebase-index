import { describe, expect, it, vi } from 'vitest';
import { MetricsCollector } from '../../../src/observability/metrics-collector.js';

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
    // Both processedFiles and totalFiles reflect the current batch only.
    expect(lastCall).toEqual([3, 3, false]);
  });

  it('resets indexing state even when processEvents throws', async () => {
    const { pipeline, onIndexingProgress } = await createPipelineWithProgressSpy();

    await expect(
      pipeline.processEvents([
        { type: 'added', filePath: 'src/a.ts', detectedAt: new Date().toISOString() },
      ]),
    ).rejects.toThrow('loadContent is required for added/modified events');

    const activeFlags = onIndexingProgress.mock.calls.map((call) => call[2]);
    expect(activeFlags.at(-1)).toBe(false);
    expect(pipeline.getProgress().currentFile).toBeUndefined();
  });
  it('publishes metrics to MetricsCollector registry', async () => {
    const metricsCollector = new MetricsCollector({ projectName: 'test-proj' });
    const deps = await createPipeline();
    const pipeline = new IndexPipeline({
      metadataStore: deps.metadataStore,
      vectorStore: deps.vectorStore,
      chunker: deps.chunker,
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: deps.registry,
      metricsHooks: metricsCollector,
    });

    await pipeline.processEvents([
      { type: 'deleted', filePath: 'src/a.ts', detectedAt: new Date().toISOString() },
      { type: 'deleted', filePath: 'src/b.ts', detectedAt: new Date().toISOString() },
    ]);

    const metrics = await metricsCollector.registry.getMetricsAsJSON();
    const totalFiles = metrics.find((m) => m.name === 'nexus_indexing_total_files')?.values[0]?.value;
    const processedFiles = metrics.find((m) => m.name === 'nexus_indexing_processed_files')?.values[0]?.value;
    const active = metrics.find((m) => m.name === 'nexus_indexing_active')?.values[0]?.value;

    expect(totalFiles).toBe(2);
    expect(active).toBe(0);
  });
  it('does not overwrite totalFiles when processing an empty array', async () => {
    const { pipeline, onIndexingProgress } = await createPipelineWithProgressSpy();

    // First, process some events to set a non-zero total.
    await pipeline.processEvents([
      { type: 'deleted', filePath: 'src/a.ts', detectedAt: new Date().toISOString() },
    ]);
    onIndexingProgress.mockClear();

    // Processing an empty array should be a no-op and not touch totalFiles.
    const result = await pipeline.processEvents([]);
    expect(result.chunksIndexed).toBe(0);
    expect(onIndexingProgress).not.toHaveBeenCalled();
    expect(pipeline.getProgress().totalFiles).toBe(1); // still from first call
  });

  it('does not update indexing progress when trackProgress is false', async () => {
    const { pipeline, onIndexingProgress } = await createPipelineWithProgressSpy();

    // First, set up progress state as if a full scan is running.
    await pipeline.processEvents([
      { type: 'deleted', filePath: 'src/a.ts', detectedAt: new Date().toISOString() },
      { type: 'deleted', filePath: 'src/b.ts', detectedAt: new Date().toISOString() },
      { type: 'deleted', filePath: 'src/c.ts', detectedAt: new Date().toISOString() },
    ]);
    onIndexingProgress.mockClear();
    const progressBefore = pipeline.getProgress();

    // Processing a single event without progress tracking must not reset counters.
    await pipeline.processEvents(
      [{ type: 'deleted', filePath: 'src/d.ts', detectedAt: new Date().toISOString() }],
      undefined,
      { trackProgress: false },
    );

    expect(onIndexingProgress).not.toHaveBeenCalled();
    const progressAfter = pipeline.getProgress();
    expect(progressAfter.totalFiles).toBe(progressBefore.totalFiles);
    expect(progressAfter.processedFiles).toBe(progressBefore.processedFiles);
  });

});
