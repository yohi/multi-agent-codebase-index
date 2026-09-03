import { describe, expect, it } from 'vitest';
import type { IStructuredCatalog } from '../../src/storage/interfaces/structured-catalog.js';

const generation = (id: string, filePath: string) => ({
  filePath,
  generation: { generationId: id, schemaVersion: 1 as const, parserId: 'test', parserVersion: '1', fileHash: id, fileCompleteness: 'complete' as const },
  declarations: [],
  imports: [],
  rebuildEpoch: 0,
  bytes: new TextEncoder().encode('function a() {}'),
  fileHash: id,
  fileCompleteness: 'complete' as const,
});

export const structuredCatalogContract = (createStore: () => Promise<IStructuredCatalog>): void => {
  describe('structured catalog contract', () => {
    const structuredDeclaration = (symbolId: string) => ({
      symbolId,
      qualifiedName: symbolId,
      kind: 'function' as const,
      signatureDiscriminator: 'a()',
      position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
      name: symbolId,
      startByte: 0,
      endByte: 14,
      sourceHash: '',
      languageId: 'typescript',
      isExact: true,
    });

    it('keeps active symbols visible while a replacement generation is pending', async () => {
      const store = await createStore();
      const declaration = (symbolId: string) => ({ symbolId, qualifiedName: 'a', kind: 'function' as const, signatureDiscriminator: 'a()', position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, name: 'a', startByte: 0, endByte: 14, sourceHash: '', languageId: 'typescript', isExact: true });
      const first = { ...generation('g1', 'src/a.ts'), declarations: [declaration('s1')] };
      const replacement = { ...generation('g2', 'src/a.ts'), declarations: [declaration('s2')] };
      await store.stageGeneration(first);
      expect((await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 0 })).activated).toBe(true);
      await store.stageGeneration(replacement);
      expect((await store.resolveSymbol('s1')).kind).toBe('active');
      expect((await store.getPendingSymbol('s2')).kind).toBe('pending');
    });

    it('rejects stale activation and atomically rejects stale pending cleanup', async () => {
      const store = await createStore();
      await store.stageGeneration(generation('g1', 'src/a.ts'));
      expect((await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: 'wrong', expectedRebuildEpoch: 0 })).activated).toBe(false);
      await store.stageGeneration(generation('g2', 'src/a.ts'));
      expect(await store.clearPendingGeneration({ filePath: 'src/a.ts', expectedActiveGeneration: null, expectedPendingGeneration: 'g1', expectedRebuildEpoch: 0 })).toEqual({ cleared: false });
      expect(await store.resolveFile('src/a.ts')).toEqual({ kind: 'pending', generationId: 'g2' });
    });
    it('reports activation precondition failures in a consistent order', async () => {
      const store = await createStore();
      await store.stageGeneration(generation('g1', 'src/a.ts'));

      expect(await store.activateGeneration({
        filePath: 'src/a.ts',
        generationId: 'missing',
        expectedActiveGeneration: 'stale',
        expectedRebuildEpoch: 1,
      })).toEqual({ activated: false, reason: 'stale_rebuild_epoch' });
    });

    it('accepts a staged generation when its rebuild epoch matches', async () => {
      const store = await createStore();
      await store.stageGeneration({ ...generation('g1', 'src/a.ts'), rebuildEpoch: 7 });

      expect(await store.activateGeneration({
        filePath: 'src/a.ts',
        generationId: 'g1',
        expectedActiveGeneration: null,
        expectedRebuildEpoch: 7,
      })).toEqual({ activated: true });
    });

    it('tombstones removed symbols and clears tombstones when symbols reappear', async () => {
      const store = await createStore();
      await store.stageGeneration({ ...generation('g1', 'src/a.ts'), declarations: [structuredDeclaration('old')] });
      await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g1', expectedActiveGeneration: null, expectedRebuildEpoch: 0 });

      await store.stageGeneration(generation('g2', 'src/a.ts'));
      await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g2', expectedActiveGeneration: 'g1', expectedRebuildEpoch: 0 });
      expect(await store.getTombstone('old')).not.toBeNull();

      await store.stageGeneration({ ...generation('g3', 'src/a.ts'), declarations: [structuredDeclaration('old')] });
      await store.activateGeneration({ filePath: 'src/a.ts', generationId: 'g3', expectedActiveGeneration: 'g2', expectedRebuildEpoch: 0 });
      expect(await store.getTombstone('old')).toBeNull();
      expect((await store.getStructuredCounts()).tombstones).toBe(0);
    });
  });
};
