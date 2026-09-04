import { describe, expect, it, vi } from 'vitest';
import { Chunker } from '../../../src/indexer/chunker.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import type { IndexEvent } from '../../../src/types/index.js';
import { createPipeline } from '../../shared/test-helpers.js';
import { createStructuredCoordinatorFixture } from '../../shared/structured-test-helpers.js';

describe('IndexPipeline rename detection', () => {
  it('detects rename and reuses vector store entries', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const provider = new TestEmbeddingProvider();
    const embedSpy = vi.spyOn(provider, 'embed');
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: provider,
      pluginRegistry: registry,
    });

    const content = 'export const test = 1;';
    const hash = 'hash-xyz';
    const addedEvent: IndexEvent = { type: 'added', filePath: 'src/old.ts', contentHash: hash, detectedAt: '' };
    
    await pipeline.processEvents([addedEvent], async () => content);
    expect(embedSpy).toHaveBeenCalled();

    embedSpy.mockClear();

    const renameEvents: IndexEvent[] = [
      { type: 'deleted', filePath: 'src/old.ts', contentHash: hash, detectedAt: '' },
      { type: 'added', filePath: 'src/new.ts', contentHash: hash, detectedAt: '' }
    ];

    const renameSpy = vi.spyOn(vectorStore, 'renameFilePath');
    await pipeline.processEvents(renameEvents, async () => content);

    expect(renameSpy).toHaveBeenCalledWith('src/old.ts', 'src/new.ts');
    
    expect(embedSpy).not.toHaveBeenCalled();

    const results = await vectorStore.search(new Array(64).fill(0), 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.chunk.filePath).toBe('src/new.ts');
  });

  it('rebuilds structured state instead of using vector-only rename optimization', async () => {
    const fixture = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });
    const pipeline = new IndexPipeline({
      metadataStore: fixture.metadataStore,
      vectorStore: fixture.vectorStore,
      chunker: new Chunker(fixture.pluginRegistry),
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: fixture.pluginRegistry,
      structuredIndexCoordinator: fixture.coordinator,
    });
    const content = 'export function renamedSymbol() { return 1; }';
    const hash = 'hash-structured-rename';
    const oldPath = 'src/old-structured.ts';
    const newPath = 'src/new-structured.ts';
    const renameSpy = vi.spyOn(fixture.vectorStore, 'renameFilePath');

    await pipeline.processEvents([
      { type: 'added', filePath: oldPath, contentHash: hash, detectedAt: '' },
    ], async () => content);

    const [oldDeclaration] = await fixture.metadataStore.getFileDeclarations(oldPath);
    expect(oldDeclaration).toBeDefined();

    await pipeline.reindex(
      async () => [
        { type: 'deleted', filePath: oldPath, contentHash: hash, detectedAt: '' },
        { type: 'added', filePath: newPath, contentHash: hash, detectedAt: '' },
      ],
      async () => content,
      true,
    );

    expect(renameSpy).not.toHaveBeenCalled();
    await expect(fixture.metadataStore.resolveFile(oldPath)).resolves.toEqual({ kind: 'missing' });
    await expect(fixture.metadataStore.resolveSymbol(oldDeclaration!.symbolId)).resolves.toMatchObject({
      kind: 'tombstone',
    });
    await expect(fixture.metadataStore.resolveFile(newPath)).resolves.toMatchObject({ kind: 'active' });

    const [newDeclaration] = await fixture.metadataStore.getFileDeclarations(newPath);
    expect(newDeclaration?.symbolId).toBeDefined();
    expect(newDeclaration?.symbolId).not.toBe(oldDeclaration?.symbolId);
    await expect(fixture.metadataStore.resolveSymbol(newDeclaration!.symbolId)).resolves.toMatchObject({
      kind: 'active',
    });
  });

  it('rebuilds structured state for an incremental rename', async () => {
    const fixture = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });
    const pipeline = new IndexPipeline({
      metadataStore: fixture.metadataStore,
      vectorStore: fixture.vectorStore,
      chunker: new Chunker(fixture.pluginRegistry),
      embeddingProvider: new TestEmbeddingProvider(),
      pluginRegistry: fixture.pluginRegistry,
      structuredIndexCoordinator: fixture.coordinator,
    });
    const content = 'export function incrementallyRenamed() { return 1; }';
    const hash = 'hash-incremental-structured-rename';
    const oldPath = 'src/old-incremental.ts';
    const newPath = 'src/new-incremental.ts';
    const renameSpy = vi.spyOn(fixture.vectorStore, 'renameFilePath');

    await pipeline.processEvents([
      { type: 'added', filePath: oldPath, contentHash: hash, detectedAt: '' },
    ], async () => content);

    const [oldDeclaration] = await fixture.metadataStore.getFileDeclarations(oldPath);
    expect(oldDeclaration).toBeDefined();

    await pipeline.processEvents([
      { type: 'deleted', filePath: oldPath, contentHash: hash, detectedAt: '' },
      { type: 'added', filePath: newPath, contentHash: hash, detectedAt: '' },
    ], async () => content);

    expect(renameSpy).not.toHaveBeenCalled();
    await expect(fixture.metadataStore.resolveFile(oldPath)).resolves.toEqual({ kind: 'missing' });
    await expect(fixture.metadataStore.resolveSymbol(oldDeclaration!.symbolId)).resolves.toMatchObject({
      kind: 'tombstone',
    });
    await expect(fixture.metadataStore.resolveFile(newPath)).resolves.toMatchObject({ kind: 'active' });

    const [newDeclaration] = await fixture.metadataStore.getFileDeclarations(newPath);
    expect(newDeclaration?.symbolId).toBeDefined();
    expect(newDeclaration?.symbolId).not.toBe(oldDeclaration?.symbolId);
  });
});
