import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymbolRetrievalService } from '../../../src/structured/retrieval-service.js';
import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import { createGenerationId, createSymbolId } from '../../../src/structured/identity.js';
import { sha256Hex } from '../../../src/structured/hash.js';
import type { StructuredDeclaration, StructuredImport } from '../../../src/structured/contracts.js';
import {
  createStructuredCoordinatorFixture,
  createStructuredSource,
  createStructuredStage,
  runStructuredFullRebuild,
  stageStructuredFile,
} from '../../shared/structured-test-helpers.js';
import type { StructuredIndexCoordinator } from '../../../src/indexer/structured-index-coordinator.js';
import type { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import type { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';

interface ImportFixture {
  readonly importText: string;
  readonly symbolText: string;
  readonly text: string;
  readonly source: ReturnType<typeof createStructuredSource>;
  readonly generationId: string;
  readonly contentHash: string;
  readonly symbolId: string;
  readonly declaration: StructuredDeclaration;
  readonly importRecord: StructuredImport;
}

const makeImportFixture = (): ImportFixture => {
  const importText = 'import { café } from "./dep.js";';
  const symbolText = 'export function a() { return 1; }';
  const text = `${importText}\n${symbolText}`;
  const source = createStructuredSource('src/a.ts', text);
  const contentHash = sha256Hex(source.bytes);
  const generationId = createGenerationId({
    schemaVersion: 1,
    parserId: 'test',
    parserVersion: '1',
    contentHash,
  });
  const symbolId = createSymbolId({
    filePath: 'src/a.ts',
    qualifiedName: 'a',
    kind: 'function',
    signatureDiscriminator: 'fn',
    occurrence: 0,
  });
  const importStart = 0;
  const importEnd = Buffer.byteLength(importText, 'utf8');
  const symbolStart = importEnd + 1;
  const declaration: StructuredDeclaration = {
    name: 'a',
    symbolId,
    qualifiedName: 'a',
    kind: 'function',
    signatureDiscriminator: 'fn',
    position: { startLine: 2, startColumn: 0, endLine: 2, endColumn: symbolText.length },
    startByte: symbolStart,
    endByte: source.bytes.length,
    sourceHash: sha256Hex(source.bytes.subarray(symbolStart, source.bytes.length)),
    languageId: 'typescript',
    isExact: true,
  };
  const importRecord: StructuredImport = {
    id: 'import-1',
    moduleSpecifier: './dep.js',
    bindingName: 'café',
    startByte: importStart,
    endByte: importEnd,
    sourceHash: sha256Hex(source.bytes.subarray(importStart, importEnd)),
    completeness: 'complete',
    position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: importText.length },
  };

  return { importText, symbolText, text, source, generationId, contentHash, symbolId, declaration, importRecord };
};

const runImportFixture = async (coordinator: StructuredIndexCoordinator, fixture: ImportFixture): Promise<void> => {
  await coordinator.runFullRebuild({
    files: [{
      source: fixture.source,
      generationId: fixture.generationId,
      contentHash: fixture.contentHash,
      fileCompleteness: 'complete',
      declarations: [fixture.declaration],
      imports: [fixture.importRecord],
    }],
  });
};

describe('SymbolRetrievalService', () => {
  let projectRoot: string;
  let catalog: InMemoryMetadataStore;
  let vectorStore: InMemoryVectorStore;
  let sanitizer: PathSanitizer;
  let service: SymbolRetrievalService;
  let coordinator: StructuredIndexCoordinator;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'nexus-retrieval-test-'));
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    const fixture = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });
    catalog = fixture.metadataStore;
    vectorStore = fixture.vectorStore;
    coordinator = fixture.coordinator;
    sanitizer = await PathSanitizer.create(projectRoot);
    service = new SymbolRetrievalService({ catalog, sanitizer });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('does not read or return source when an ID is pending', async () => {
    const text = 'export function a() { return 1; }';
    const stage = createStructuredStage('src/a.ts', text, 'a');
    await stageStructuredFile(coordinator, stage);

    const result = await service.getSymbolSource({ symbolId: stage.symbolId });
    expect(result).toEqual({
      status: 'index_incomplete',
      reasonCode: 'INDEX_PENDING_GENERATION',
      request: { symbolId: stage.symbolId },
    });
  });

  it('reads one buffer, rejects a changed file, and omits source', async () => {
    const text = 'export function a() { return 1; }';
    const stage = createStructuredStage('src/a.ts', text, 'a');
    await runStructuredFullRebuild(coordinator, stage);

    await writeFile(join(projectRoot, 'src/a.ts'), 'changed');
    const result = await service.getSymbolSource({ symbolId: stage.symbolId });
    expect(result).toMatchObject({ status: 'stale', reasonCode: 'INDEX_FILE_HASH_MISMATCH' });
    expect(result).not.toHaveProperty('source');
  });

  it('returns the old active source after failed stage cleanup when its bytes are current', async () => {
    const firstText = 'export function a() { return 1; }';
    const first = createStructuredStage('src/a.ts', firstText, 'a');

    await stageStructuredFile(coordinator, first);
    await coordinator.activateFile({ filePath: 'src/a.ts', generationId: first.generationId });

    // Force the next staging to fail after catalog metadata is written but vectors are not.
    // Note: InMemoryVectorStore begins a shadow only for runFullRebuild; stageFile writes
    // directly to structuredRecords, so failOnBatch applies to the second stageFile call.
    vectorStore.failOnBatch(2);
    const secondText = 'export function a() { return 2; }';
    const second = createStructuredStage('src/a.ts', secondText, 'a');
    await expect(stageStructuredFile(coordinator, second)).rejects.toThrow();

    await writeFile(join(projectRoot, 'src/a.ts'), firstText);
    const result = await service.getSymbolSource({ symbolId: first.symbolId });
    expect(result).toMatchObject({
      status: 'ok',
      freshness: 'fresh',
      source: firstText,
    });
  });

  it('fails closed before packing when one candidate import no longer matches its indexed hash', async () => {
    const fixture = makeImportFixture();
    await runImportFixture(coordinator, fixture);

    await writeFile(join(projectRoot, 'src/a.ts'), `${fixture.importText.replace('café', 'cafe2')}\n${fixture.symbolText}`);
    const result = await service.getSymbolContext({ symbolId: fixture.symbolId, tokenBudget: 100 });
    expect(result).toMatchObject({ status: 'index_incomplete', reasonCode: 'INDEX_IMPORT_HASH_MISMATCH' });
    expect(result).not.toHaveProperty('context');
  });

  it('derives an import rawSource from its verified UTF-8 byte slice', async () => {
    const fixture = makeImportFixture();
    await runImportFixture(coordinator, fixture);

    await writeFile(join(projectRoot, 'src/a.ts'), fixture.text);
    const result = await service.getSymbolContext({ symbolId: fixture.symbolId, tokenBudget: 100 });
    expect(result).toMatchObject({ status: 'ok' });
    expect((result as { context: string }).context).toContain(fixture.importText);
  });

  it('keeps source order and later small imports after a too-large earlier import', async () => {
    const largeImport = 'import '.repeat(50);
    const smallImport = 'import { x } from "./small.js";';
    const symbolText = 'export function a() { return 1; }';
    const text = `${largeImport}\n${smallImport}\n${symbolText}`;
    const source = createStructuredSource('src/a.ts', text);
    const generationId = createGenerationId({ schemaVersion: 1, parserId: 'test', parserVersion: '1', contentHash: sha256Hex(source.bytes) });
    const symbolId = createSymbolId({ filePath: 'src/a.ts', qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn', occurrence: 0 });
    const largeEnd = Buffer.byteLength(largeImport, 'utf8');
    const smallStart = largeEnd + 1;
    const smallEnd = smallStart + Buffer.byteLength(smallImport, 'utf8');
    await coordinator.runFullRebuild({
      files: [{
        source,
        generationId,
        contentHash: sha256Hex(source.bytes),
        fileCompleteness: 'complete',
        declarations: [{
          name: 'a', symbolId, qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn',
          position: { startLine: 3, startColumn: 0, endLine: 3, endColumn: symbolText.length },
          startByte: smallEnd + 1, endByte: source.bytes.length, sourceHash: sha256Hex(source.bytes.subarray(smallEnd + 1, source.bytes.length)),
          languageId: 'typescript', isExact: true,
        }],
        imports: [
          {
            id: 'large', moduleSpecifier: './large.js', bindingName: 'a',
            startByte: 0, endByte: largeEnd,
            sourceHash: sha256Hex(source.bytes.subarray(0, largeEnd)),
            completeness: 'complete',
            position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: largeImport.length },
          },
          {
            id: 'small', moduleSpecifier: './small.js', bindingName: 'x',
            startByte: smallStart, endByte: smallEnd,
            sourceHash: sha256Hex(source.bytes.subarray(smallStart, smallEnd)),
            completeness: 'complete',
            position: { startLine: 2, startColumn: 0, endLine: 2, endColumn: smallImport.length },
          },
        ],
      }],
    });

    await writeFile(join(projectRoot, 'src/a.ts'), text);
    const result = await service.getSymbolContext({ symbolId, tokenBudget: 20 });
    expect((result as { imports: Array<{ moduleSpecifier?: string }> }).imports.map((item) => item.moduleSpecifier)).toEqual(['./small.js']);
    expect((result as { budget: { omittedForBudget: number } }).budget.omittedForBudget).toBe(1);
  });
});
