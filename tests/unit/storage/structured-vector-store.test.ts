import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import type { CodeChunk } from '../../../src/types/index.js';

const makeChunk = (overrides: Partial<CodeChunk> = {}): CodeChunk => ({
  id: overrides.id ?? 'chunk-1',
  filePath: overrides.filePath ?? 'src/index.ts',
  content: overrides.content ?? 'export const value = 1;',
  language: overrides.language ?? 'typescript',
  symbolName: overrides.symbolName,
  symbolKind: overrides.symbolKind ?? 'function',
  startLine: overrides.startLine ?? 1,
  endLine: overrides.endLine ?? 1,
  hash: overrides.hash ?? 'hash-1',
  symbolId: overrides.symbolId,
});

const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));

describe('LanceVectorStore structured rows', () => {
  let tmpDir: string;
  let store: LanceVectorStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-structured-'));
    store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
    await store.initialize();
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {}
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('stages pending structured rows with symbolId, generationId, and visibility', async () => {
    await store.stageGenerationChunks({
      filePath: 'src/a.ts',
      generationId: 'gen-1',
      chunks: [makeChunk({ id: 'a', filePath: 'src/a.ts', symbolId: 'symbol-1' })],
      vectors: [embedding],
    });

    const pending = await store.search(embedding, 10);
    expect(pending).toHaveLength(0);
  });

  it('returns active rows with generationId after activation', async () => {
    await store.stageGenerationChunks({
      filePath: 'src/a.ts',
      generationId: 'gen-1',
      chunks: [makeChunk({ id: 'a', filePath: 'src/a.ts', symbolId: 'symbol-1' })],
      vectors: [embedding],
    });

    await store.activateGenerationRows('src/a.ts', 'gen-1');

    const results = await store.search(embedding, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe('a');
    expect(results[0]?.generationId).toBe('gen-1');
    expect(results[0]?.chunk.symbolId).toBe('symbol-1');
  });

  it('hides pending rows and keeps other active generations visible', async () => {
    await store.stageGenerationChunks({
      filePath: 'src/a.ts',
      generationId: 'gen-1',
      chunks: [makeChunk({ id: 'a1', filePath: 'src/a.ts', symbolId: 'symbol-1' })],
      vectors: [embedding],
    });
    await store.activateGenerationRows('src/a.ts', 'gen-1');

    await store.stageGenerationChunks({
      filePath: 'src/a.ts',
      generationId: 'gen-2',
      chunks: [makeChunk({ id: 'a2', filePath: 'src/a.ts', symbolId: 'symbol-2' })],
      vectors: [embedding],
    });

    const results = await store.search(embedding, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.generationId).toBe('gen-1');
  });

  it('removeGenerationRows deletes only the targeted file and generation', async () => {
    await store.stageGenerationChunks({
      filePath: 'src/a.ts',
      generationId: 'gen-1',
      chunks: [makeChunk({ id: 'a1', filePath: 'src/a.ts', symbolId: 'symbol-1' })],
      vectors: [embedding],
    });
    await store.stageGenerationChunks({
      filePath: 'src/b.ts',
      generationId: 'gen-1',
      chunks: [makeChunk({ id: 'b1', filePath: 'src/b.ts', symbolId: 'symbol-b' })],
      vectors: [embedding],
    });

    await store.activateGenerationRows('src/a.ts', 'gen-1');
    await store.activateGenerationRows('src/b.ts', 'gen-1');
    await store.removeGenerationRows('src/a.ts', 'gen-1');

    const results = await store.search(embedding, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.filePath).toBe('src/b.ts');
  });

  it('reconcileStructuredRows keeps only catalog-active generations', async () => {
    await store.stageGenerationChunks({
      filePath: 'src/a.ts',
      generationId: 'gen-1',
      chunks: [makeChunk({ id: 'a1', filePath: 'src/a.ts', symbolId: 'symbol-1' })],
      vectors: [embedding],
    });
    await store.stageGenerationChunks({
      filePath: 'src/a.ts',
      generationId: 'gen-2',
      chunks: [makeChunk({ id: 'a2', filePath: 'src/a.ts', symbolId: 'symbol-2' })],
      vectors: [embedding],
    });

    await store.activateGenerationRows('src/a.ts', 'gen-1');
    await store.activateGenerationRows('src/a.ts', 'gen-2');
    await store.reconcileStructuredRows([{ filePath: 'src/a.ts', generationId: 'gen-2' }]);

    const results = await store.search(embedding, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.generationId).toBe('gen-2');
  });

  it('shadow table swap replaces live structured rows', async () => {
    await store.stageGenerationChunks({
      filePath: 'src/a.ts',
      generationId: 'gen-1',
      chunks: [makeChunk({ id: 'a1', filePath: 'src/a.ts', symbolId: 'symbol-1' })],
      vectors: [embedding],
    });
    await store.activateGenerationRows('src/a.ts', 'gen-1');

    const shadowTable = await store.beginStructuredShadowTable();
    await store.stageGenerationChunks({
      filePath: 'src/b.ts',
      generationId: 'gen-2',
      chunks: [makeChunk({ id: 'b1', filePath: 'src/b.ts', symbolId: 'symbol-2' })],
      vectors: [embedding],
    });
    await store.swapStructuredShadowTable(shadowTable);

    const results = await store.search(embedding, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.filePath).toBe('src/b.ts');
  });

  it('legacy upsert does not write symbolId or generationId', async () => {
    await store.upsertChunks(
      [makeChunk({ id: 'legacy', filePath: 'src/legacy.ts' })],
      [embedding],
    );

    const results = await store.search(embedding, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.generationId).toBeUndefined();
    expect(results[0]?.chunk.symbolId).toBeUndefined();
  });

  it('does not add structured columns to the legacy chunks table', async () => {
    await store.upsertChunks(
      [makeChunk({ id: 'legacy', filePath: 'src/legacy.ts' })],
      [embedding],
    );

    const schema = await store['table']!.schema();
    const columnNames = schema.fields.map((f) => f.name);
    expect(columnNames).not.toContain('symbolid');
    expect(columnNames).not.toContain('generationid');
    expect(columnNames).not.toContain('visibility');
  });
});
