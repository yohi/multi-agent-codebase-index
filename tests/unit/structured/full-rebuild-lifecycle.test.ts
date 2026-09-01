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
import type { StructuredSource, StructuredDeclaration, StructuredImport } from '../../../src/structured/contracts.js';

const makeSource = (filePath: string, text: string): StructuredSource => {
  const bytes = Buffer.from(text, 'utf8');
  return {
    filePath,
    language: 'typescript',
    bytes,
    text: decodeUtf8(bytes),
  };
};

const makeSymbol = (
  filePath: string,
  qualifiedName: string,
  startByte: number,
  endByte: number,
  sourceHash: string,
): StructuredDeclaration => ({
  name: qualifiedName,
  symbolId: createSymbolId({
    filePath,
    qualifiedName,
    kind: 'function',
    signatureDiscriminator: 'fn',
    occurrence: 0,
  }),
  qualifiedName,
  kind: 'function',
  signatureDiscriminator: 'fn',
  position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 30 },
  startByte,
  endByte,
  sourceHash,
  languageId: 'typescript',
  isExact: true,
});

const makeStage = (
  filePath: string,
  text: string,
  qualifiedName: string,
  startByte: number,
  endByte: number,
) => {
  const source = makeSource(filePath, text);
  const contentHash = sha256Hex(source.bytes);
  return {
    source,
    generationId: createGenerationId({
      schemaVersion: 1,
      parserId: 'test',
      parserVersion: '1',
      contentHash,
    }),
    contentHash,
    symbol: makeSymbol(filePath, qualifiedName, startByte, endByte, contentHash),
  };
};

describe('full rebuild lifecycle', () => {
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

  it('keeps a completed legacy index searchable through old tools but gates new tools', async () => {
    const state = await metadataStore.getStructuredIndexState();
    expect(state.schemaVersion).toBeNull();
    expect(state.reindexRequired).toBe(true);
    expect(await metadataStore.resolveFile('src/auth.ts')).toMatchObject({
      kind: 'missing',
    });
  });

  it('does not activate a swapped shadow table when final SQLite activation fails', async () => {
    const stage = makeStage('src/a.ts', 'export function a() { return 1; }', 'a', 0, 30);
    const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));

    const originalActivate = metadataStore.activateGeneration.bind(metadataStore);
    metadataStore.activateGeneration = async (input) => {
      if (input.generationId === stage.generationId) {
        throw new Error('final activation failed');
      }
      return originalActivate(input);
    };

    await expect(
      coordinator.runFullRebuild({
        files: [{
          source: stage.source,
          generationId: stage.generationId,
          contentHash: stage.contentHash,
          fileCompleteness: 'complete',
          declarations: [stage.symbol],
          imports: [],
        }],
      }),
    ).rejects.toThrow('final activation failed');

    const state = await metadataStore.getStructuredIndexState();
    expect(state.rebuildState).toBe('failed');
    expect(await vectorStore.search(embedding, 10)).toHaveLength(0);
  });
});
