import { describe, expect, it } from 'vitest';
import type { IStructuredCatalog } from '../../src/storage/interfaces/structured-catalog.js';

const generation = (id: string, filePath: string) => ({
  filePath,
  generation: { generationId: id, schemaVersion: 1 as const, parserId: 'test', parserVersion: '1', contentHash: id },
  declarations: [],
  imports: [],
  rebuildEpoch: 0,
});

export const structuredCatalogContract = (createStore: () => Promise<IStructuredCatalog>): void => {
  describe('structured catalog contract', () => {
    it('keeps active symbols visible while a replacement generation is pending', async () => {
      const store = await createStore();
      const first = { ...generation('g1', 'src/a.ts'), declarations: [{ symbolId: 's1', qualifiedName: 'a', kind: 'function' as const, signatureDiscriminator: 'a()', position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, name: 'a', content: 'function a() {}' }] };
      const replacement = { ...generation('g2', 'src/a.ts'), declarations: [{ symbolId: 's2', qualifiedName: 'a', kind: 'function' as const, signatureDiscriminator: 'a()', position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 }, name: 'a', content: 'function a() {}' }] };
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
  });
};
