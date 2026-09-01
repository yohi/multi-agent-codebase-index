import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';
import { StructuredIndexCoordinator } from '../../../src/indexer/structured-index-coordinator.js';
import { ProjectWriteCoordinator } from '../../../src/indexer/project-write-coordinator.js';
import { SymbolRetrievalService } from '../../../src/structured/retrieval-service.js';
import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import { createGenerationId, createSymbolId } from '../../../src/structured/identity.js';
import { sha256Hex, decodeUtf8 } from '../../../src/structured/hash.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { Chunker } from '../../../src/indexer/chunker.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import type { StructuredSource } from '../../../src/structured/contracts.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const makeSource = (filePath: string, text: string): StructuredSource => {
  const bytes = Buffer.from(text, 'utf8');
  return { filePath, language: 'typescript', bytes, text: decodeUtf8(bytes) };
};

describe('SymbolRetrievalService', () => {
  let projectRoot: string;
  let catalog: InMemoryMetadataStore;
  let vectorStore: InMemoryVectorStore;
  let sanitizer: PathSanitizer;
  let service: SymbolRetrievalService;
  let coordinator: StructuredIndexCoordinator;

  beforeEach(async () => {
    projectRoot = join(tmpdir(), `nexus-retrieval-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    catalog = new InMemoryMetadataStore();
    vectorStore = new InMemoryVectorStore({ dimensions: 64 });
    await catalog.initialize();
    await catalog.bootstrapStructuredSchema();
    await vectorStore.initialize();
    sanitizer = await PathSanitizer.create(projectRoot);
    service = new SymbolRetrievalService({ catalog, sanitizer });
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    coordinator = new StructuredIndexCoordinator({
      metadataStore: catalog,
      vectorStore,
      chunker: new Chunker(registry),
      projectWriteCoordinator: new ProjectWriteCoordinator(),
    });
  });

  it('does not read or return source when an ID is pending', async () => {
    const text = 'export function a() { return 1; }';
    const source = makeSource('src/a.ts', text);
    const generationId = createGenerationId({ schemaVersion: 1, parserId: 'test', parserVersion: '1', contentHash: sha256Hex(source.bytes) });
    const symbolId = createSymbolId({ filePath: 'src/a.ts', qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn', occurrence: 0 });
    await coordinator.stageFile({
      source,
      generationId,
      contentHash: sha256Hex(source.bytes),
      fileCompleteness: 'complete',
      declarations: [{
        name: 'a', symbolId, qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn',
        position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: text.length },
        startByte: 0, endByte: source.bytes.length, sourceHash: sha256Hex(source.bytes),
        languageId: 'typescript', isExact: true,
      }],
      imports: [],
    });

    const result = await service.getSymbolSource({ symbolId });
    expect(result).toEqual({
      status: 'index_incomplete',
      reasonCode: 'INDEX_PENDING_GENERATION',
      request: { symbolId },
    });
  });

  it('reads one buffer, rejects a changed file, and omits source', async () => {
    const text = 'export function a() { return 1; }';
    const source = makeSource('src/a.ts', text);
    const generationId = createGenerationId({ schemaVersion: 1, parserId: 'test', parserVersion: '1', contentHash: sha256Hex(source.bytes) });
    const symbolId = createSymbolId({ filePath: 'src/a.ts', qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn', occurrence: 0 });
    await coordinator.runFullRebuild({
      files: [{
        source,
        generationId,
        contentHash: sha256Hex(source.bytes),
        fileCompleteness: 'complete',
        declarations: [{
          name: 'a', symbolId, qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn',
          position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: text.length },
          startByte: 0, endByte: source.bytes.length, sourceHash: sha256Hex(source.bytes),
          languageId: 'typescript', isExact: true,
        }],
        imports: [],
      }],
    });

    await writeFile(join(projectRoot, 'src/a.ts'), 'changed');
    const result = await service.getSymbolSource({ symbolId });
    expect(result).toMatchObject({ status: 'stale', reasonCode: 'INDEX_FILE_HASH_MISMATCH' });
    expect(result).not.toHaveProperty('source');
  });

  it('returns the old active source after failed stage cleanup when its bytes are current', async () => {
    const firstText = 'export function a() { return 1; }';
    const firstSource = makeSource('src/a.ts', firstText);
    const firstGenerationId = createGenerationId({ schemaVersion: 1, parserId: 'test', parserVersion: '1', contentHash: sha256Hex(firstSource.bytes) });
    const symbolId = createSymbolId({ filePath: 'src/a.ts', qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn', occurrence: 0 });

    await coordinator.stageFile({
      source: firstSource,
      generationId: firstGenerationId,
      contentHash: sha256Hex(firstSource.bytes),
      fileCompleteness: 'complete',
      declarations: [{
        name: 'a', symbolId, qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn',
        position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: firstText.length },
        startByte: 0, endByte: firstSource.bytes.length, sourceHash: sha256Hex(firstSource.bytes),
        languageId: 'typescript', isExact: true,
      }],
      imports: [],
    });
    await coordinator.activateFile({ filePath: 'src/a.ts', generationId: firstGenerationId });

    // Force the next staging to fail after catalog metadata is written but vectors are not.
    // Note: InMemoryVectorStore begins a shadow only for runFullRebuild; stageFile writes
    // directly to structuredRecords, so failOnBatch applies to the second stageFile call.
    vectorStore.failOnBatch(2);
    const secondText = 'export function a() { return 2; }';
    const secondSource = makeSource('src/a.ts', secondText);
    const secondGenerationId = createGenerationId({ schemaVersion: 1, parserId: 'test', parserVersion: '1', contentHash: sha256Hex(secondSource.bytes) });
    await expect(coordinator.stageFile({
      source: secondSource,
      generationId: secondGenerationId,
      contentHash: sha256Hex(secondSource.bytes),
      fileCompleteness: 'complete',
      declarations: [{
        name: 'a', symbolId, qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn',
        position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: secondText.length },
        startByte: 0, endByte: secondSource.bytes.length, sourceHash: sha256Hex(secondSource.bytes),
        languageId: 'typescript', isExact: true,
      }],
      imports: [],
    })).rejects.toThrow();

    await writeFile(join(projectRoot, 'src/a.ts'), firstText);
    const result = await service.getSymbolSource({ symbolId });
    expect(result).toMatchObject({
      status: 'ok',
      freshness: 'fresh',
      source: firstText,
    });
  });

  it('fails closed before packing when one candidate import no longer matches its indexed hash', async () => {
    const importText = 'import { café } from "./dep.js";';
    const symbolText = 'export function a() { return 1; }';
    const text = `${importText}\n${symbolText}`;
    const source = makeSource('src/a.ts', text);
    const generationId = createGenerationId({ schemaVersion: 1, parserId: 'test', parserVersion: '1', contentHash: sha256Hex(source.bytes) });
    const symbolId = createSymbolId({ filePath: 'src/a.ts', qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn', occurrence: 0 });
    const importStart = 0;
    const importEnd = Buffer.byteLength(importText, 'utf8');
    await coordinator.runFullRebuild({
      files: [{
        source,
        generationId,
        contentHash: sha256Hex(source.bytes),
        fileCompleteness: 'complete',
        declarations: [{
          name: 'a', symbolId, qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn',
          position: { startLine: 2, startColumn: 0, endLine: 2, endColumn: symbolText.length },
          startByte: importEnd + 1, endByte: source.bytes.length, sourceHash: sha256Hex(source.bytes.subarray(importEnd + 1, source.bytes.length)),
          languageId: 'typescript', isExact: true,
        }],
        imports: [{
          id: 'import-1', moduleSpecifier: './dep.js', bindingName: 'café',
          startByte: importStart, endByte: importEnd,
          sourceHash: sha256Hex(source.bytes.subarray(importStart, importEnd)),
          completeness: 'complete',
          position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: importText.length },
        }],
      }],
    });

    await writeFile(join(projectRoot, 'src/a.ts'), `${importText.replace('café', 'cafe2')}\n${symbolText}`);
    const result = await service.getSymbolContext({ symbolId, tokenBudget: 100 });
    expect(result).toMatchObject({ status: 'index_incomplete', reasonCode: 'INDEX_IMPORT_HASH_MISMATCH' });
    expect(result).not.toHaveProperty('context');
  });

  it('derives an import rawSource from its verified UTF-8 byte slice', async () => {
    const importText = 'import { café } from "./dep.js";';
    const symbolText = 'export function a() { return 1; }';
    const text = `${importText}\n${symbolText}`;
    const source = makeSource('src/a.ts', text);
    const generationId = createGenerationId({ schemaVersion: 1, parserId: 'test', parserVersion: '1', contentHash: sha256Hex(source.bytes) });
    const symbolId = createSymbolId({ filePath: 'src/a.ts', qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn', occurrence: 0 });
    const importStart = 0;
    const importEnd = Buffer.byteLength(importText, 'utf8');
    await coordinator.runFullRebuild({
      files: [{
        source,
        generationId,
        contentHash: sha256Hex(source.bytes),
        fileCompleteness: 'complete',
        declarations: [{
          name: 'a', symbolId, qualifiedName: 'a', kind: 'function', signatureDiscriminator: 'fn',
          position: { startLine: 2, startColumn: 0, endLine: 2, endColumn: symbolText.length },
          startByte: importEnd + 1, endByte: source.bytes.length, sourceHash: sha256Hex(source.bytes.subarray(importEnd + 1, source.bytes.length)),
          languageId: 'typescript', isExact: true,
        }],
        imports: [{
          id: 'import-1', moduleSpecifier: './dep.js', bindingName: 'café',
          startByte: importStart, endByte: importEnd,
          sourceHash: sha256Hex(source.bytes.subarray(importStart, importEnd)),
          completeness: 'complete',
          position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: importText.length },
        }],
      }],
    });

    await writeFile(join(projectRoot, 'src/a.ts'), text);
    const result = await service.getSymbolContext({ symbolId, tokenBudget: 100 });
    expect(result).toMatchObject({ status: 'ok' });
    expect((result as { context: string }).context).toContain(importText);
  });

  it('keeps source order and later small imports after a too-large earlier import', async () => {
    const largeImport = 'import '.repeat(50);
    const smallImport = 'import { x } from "./small.js";';
    const symbolText = 'export function a() { return 1; }';
    const text = `${largeImport}\n${smallImport}\n${symbolText}`;
    const source = makeSource('src/a.ts', text);
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
