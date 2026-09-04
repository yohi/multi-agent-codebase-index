import { describe, expect, it, vi } from 'vitest';
import { Chunker } from '../../../src/indexer/chunker.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import type { IndexEvent } from '../../../src/types/index.js';
import { createPipeline } from '../../shared/test-helpers.js';
import { createStructuredCoordinatorFixture } from '../../shared/structured-test-helpers.js';

interface StructuredRenameSetup {
  readonly content: string;
  readonly hash: string;
  readonly oldPath: string;
  readonly newPath: string;
}

const prepareStructuredRename = async (setup: StructuredRenameSetup) => {
  const fixture = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });
  const pipeline = new IndexPipeline({
    metadataStore: fixture.metadataStore,
    vectorStore: fixture.vectorStore,
    chunker: new Chunker(fixture.pluginRegistry),
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: fixture.pluginRegistry,
    structuredIndexCoordinator: fixture.coordinator,
  });
  const renameSpy = vi.spyOn(fixture.vectorStore, 'renameFilePath');

  await pipeline.processEvents([
    { type: 'added', filePath: setup.oldPath, contentHash: setup.hash, detectedAt: '' },
  ], async () => setup.content);

  const [oldDeclaration] = await fixture.metadataStore.getFileDeclarations(setup.oldPath);
  expect(oldDeclaration).toBeDefined();

  return { ...setup, fixture, pipeline, renameSpy, oldDeclaration };
};

type StructuredRenameScenario = Awaited<ReturnType<typeof prepareStructuredRename>>;

const assertStructuredRename = async ({
  fixture,
  oldPath,
  newPath,
  renameSpy,
  oldDeclaration,
}: StructuredRenameScenario) => {
  expect(renameSpy).not.toHaveBeenCalled();
  await expect(fixture.metadataStore.resolveFile(oldPath)).resolves.toEqual({ kind: 'missing' });
  await expect(fixture.metadataStore.resolveSymbol(oldDeclaration!.symbolId)).resolves.toMatchObject({
    kind: 'tombstone',
  });
  await expect(fixture.metadataStore.resolveFile(newPath)).resolves.toMatchObject({ kind: 'active' });

  const [newDeclaration] = await fixture.metadataStore.getFileDeclarations(newPath);
  expect(newDeclaration?.symbolId).toBeDefined();
  expect(newDeclaration?.symbolId).not.toBe(oldDeclaration?.symbolId);
  return newDeclaration;
};

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
    const scenario = await prepareStructuredRename({
      content: 'export function renamedSymbol() { return 1; }',
      hash: 'hash-structured-rename',
      oldPath: 'src/old-structured.ts',
      newPath: 'src/new-structured.ts',
    });

    await scenario.pipeline.reindex(
      async () => [
        { type: 'deleted', filePath: scenario.oldPath, contentHash: scenario.hash, detectedAt: '' },
        { type: 'added', filePath: scenario.newPath, contentHash: scenario.hash, detectedAt: '' },
      ],
      async () => scenario.content,
      true,
    );

    const newDeclaration = await assertStructuredRename(scenario);
    await expect(scenario.fixture.metadataStore.resolveSymbol(newDeclaration!.symbolId)).resolves.toMatchObject({
      kind: 'active',
    });
  });

  it('rebuilds structured state for an incremental rename', async () => {
    const scenario = await prepareStructuredRename({
      content: 'export function incrementallyRenamed() { return 1; }',
      hash: 'hash-incremental-structured-rename',
      oldPath: 'src/old-incremental.ts',
      newPath: 'src/new-incremental.ts',
    });

    await scenario.pipeline.processEvents([
      { type: 'deleted', filePath: scenario.oldPath, contentHash: scenario.hash, detectedAt: '' },
      { type: 'added', filePath: scenario.newPath, contentHash: scenario.hash, detectedAt: '' },
    ], async () => scenario.content);

    await assertStructuredRename(scenario);
  });
});
