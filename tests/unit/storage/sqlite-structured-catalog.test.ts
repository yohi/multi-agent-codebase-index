import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteMetadataStore } from '../../../src/storage/metadata-store.js';
import type { StructuredGenerationStage } from '../../../src/storage/interfaces/structured-catalog.js';

const generation = (id: string) => ({ generationId: id, schemaVersion: 1 as const, parserId: 'test', parserVersion: '1', fileHash: `hash-${id}`, fileCompleteness: 'complete' as const });
const stage = (filePath: string, id: string, symbolId: string): StructuredGenerationStage => ({
  filePath, generation: generation(id), rebuildEpoch: 1, bytes: new TextEncoder().encode('not persisted'), fileHash: `hash-${id}`, fileCompleteness: 'complete',
  declarations: [{ name: symbolId, symbolId, qualifiedName: symbolId, kind: 'function', signatureDiscriminator: 'sig', position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, startByte: 0, endByte: 3, sourceHash: '', languageId: 'typescript', isExact: true }],
  imports: [],
});

describe('SQLite structured catalog', () => {
  let dir: string;
  let store: SqliteMetadataStore;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-structured-')); store = new SqliteMetadataStore({ databasePath: path.join(dir, 'metadata.db') }); });
  afterEach(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });

  it('bootstraps empty structured tables without migrating an existing search index', async () => {
    await store.initialize();
    expect((await store.getStructuredIndexState()).rebuildEpoch).toBe(0);
    expect(await store.getIndexStats()).toMatchObject({ id: 'primary' });
  });

  it('activates a staged generation and records disappeared symbols as tombstones atomically', async () => {
    await store.initialize();
    await store.stageGeneration(stage('src/a.ts', 'g1', 'old'));
    expect((await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 1 })).activated).toBe(true);
    await store.stageGeneration(stage('src/a.ts', 'g2', 'new'));
    expect((await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g2', expectedActiveGeneration: 'g1', expectedRebuildEpoch: 1 })).activated).toBe(true);
    expect(await store.getTombstone('old')).toMatchObject({ symbolId: 'old' });
    expect((await store.resolveSymbol('new')).kind).toBe('active');
  });

  it('does not clear pending generation after a compare-and-swap conflict', async () => {
    await store.initialize(); await store.stageGeneration(stage('src/a.ts', 'g1', 'one'));
    const result = await store.clearPendingGeneration({ filePath: 'src/a.ts', expectedActiveGeneration: 'wrong', expectedPendingGeneration: 'g1', expectedRebuildEpoch: 1 });
    expect(result).toEqual({ cleared: false });
    expect((await store.resolveFile('src/a.ts')).kind).toBe('pending');
  });
});
