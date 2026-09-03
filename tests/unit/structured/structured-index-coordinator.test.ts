import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';
import { StructuredIndexCoordinator } from '../../../src/indexer/structured-index-coordinator.js';
import { ProjectWriteCoordinator } from '../../../src/indexer/project-write-coordinator.js';
import { createGenerationId, createSymbolId } from '../../../src/structured/identity.js';
import { sha256Hex, decodeUtf8 } from '../../../src/structured/hash.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { Chunker } from '../../../src/indexer/chunker.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import type { StructuredSource } from '../../../src/structured/contracts.js';
const makeSource = (filePath: string, text: string): StructuredSource => {
  const bytes = Buffer.from(text, 'utf8');
  return {
    filePath,
    language: 'typescript',
    bytes,
    text: decodeUtf8(bytes),
  };
};

const makeStage = (filePath: string, text: string, qualifiedName: string) => {
  const source = makeSource(filePath, text);
  const contentHash = sha256Hex(source.bytes);
  const symbolId = createSymbolId({
    filePath,
    qualifiedName,
    kind: 'function',
    signatureDiscriminator: 'fn',
    occurrence: 0,
  });
  return {
    source,
    symbolId,
    qualifiedName,
    generationId: createGenerationId({
      schemaVersion: 1,
      parserId: 'test',
      parserVersion: '1',
      contentHash,
    }),
    contentHash,
  };
};

const stageCoordinatorFile = async (
  coordinator: StructuredIndexCoordinator,
  stage: ReturnType<typeof makeStage>,
): Promise<void> => {
  await coordinator.stageFile({
    source: stage.source,
    generationId: stage.generationId,
    contentHash: stage.contentHash,
    fileCompleteness: 'complete',
    declarations: [{
      name: stage.qualifiedName,
      symbolId: stage.symbolId,
      qualifiedName: stage.qualifiedName,
      kind: 'function',
      signatureDiscriminator: 'fn',
      position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 30 },
      startByte: 0,
      endByte: 30,
      sourceHash: stage.contentHash,
      languageId: 'typescript',
      isExact: true,
    }],
    imports: [],
  });
};

describe('StructuredIndexCoordinator', () => {
  let metadataStore: InMemoryMetadataStore;
  let vectorStore: InMemoryVectorStore;
  let chunker: Chunker;
  let projectCoordinator: ProjectWriteCoordinator;
  let coordinator: StructuredIndexCoordinator;

  beforeEach(async () => {
    metadataStore = new InMemoryMetadataStore();
    vectorStore = new InMemoryVectorStore({ dimensions: 64 });
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    chunker = new Chunker(registry);
    await metadataStore.initialize();
    await vectorStore.initialize();
    projectCoordinator = new ProjectWriteCoordinator();
    coordinator = new StructuredIndexCoordinator({
      metadataStore,
      vectorStore,
      chunker,
      projectWriteCoordinator: projectCoordinator,
    });
  });

  it('keeps the active catalog and vectors visible when Lance staging fails mid-batch', async () => {
    const first = makeStage('src/a.ts', 'export function a() { return 1; }', 'a');
    await stageCoordinatorFile(coordinator, first);
    await coordinator.activateFile({ filePath: 'src/a.ts', generationId: first.generationId });

    const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
    const resultsBefore = await vectorStore.search(embedding, 10);
    expect(resultsBefore).toHaveLength(1);

    vectorStore.failOnBatch(2);
    const second = makeStage('src/a.ts', 'export function replacement() { return 2; }', 'replacement');
    await expect(stageCoordinatorFile(coordinator, second)).rejects.toThrow();

    const resultsAfter = await vectorStore.search(embedding, 10);
    expect(resultsAfter).toHaveLength(1);
    expect(resultsAfter[0]?.chunk.symbolId).toBe(first.symbolId);
    expect(await metadataStore.getStructuredCounts()).toMatchObject({
      pendingFiles: 0,
      pendingSymbols: 0,
    });
    expect(await metadataStore.resolveFile('src/a.ts')).toEqual({
      kind: 'active',
      generationId: first.generationId,
    });
  });

  it('returns index_incomplete for a pending file instead of stale source', async () => {
    const stage = makeStage('src/a.ts', 'export function a() { return 1; }', 'a');
    await stageCoordinatorFile(coordinator, stage);

    const resolved = await metadataStore.resolveFile('src/a.ts');
    expect(resolved.kind).toBe('pending');
  });

  it('deletes structured file rows and catalog entries on delete', async () => {
    const stage = makeStage('src/a.ts', 'export function a() { return 1; }', 'a');
    await stageCoordinatorFile(coordinator, stage);
    await coordinator.activateFile({ filePath: 'src/a.ts', generationId: stage.generationId });
    expect(await vectorStore.search(new Array<number>(64).fill(0), 10)).toHaveLength(1);

    await coordinator.deleteFile({ filePath: 'src/a.ts' });

    const resolved = await metadataStore.resolveFile('src/a.ts');
    expect(resolved.kind).toBe('missing');
    const symbolResolved = await metadataStore.resolveSymbol(stage.symbolId);
    expect(symbolResolved.kind).toBe('tombstone');
    expect(await vectorStore.search(new Array<number>(64).fill(0), 10)).toHaveLength(0);
  });
});
