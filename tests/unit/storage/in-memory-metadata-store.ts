import { dirname } from 'node:path';

import type {
  DeadLetterEntry,
  EmbeddingCacheEntry,
  IMetadataStore,
  IndexStatsRow,
  MerkleNodeRow,
} from '../../../src/types/index.js';
import type {
  IStructuredCatalog,
  StructuredActivationResult,
  StructuredFileRetirement,
  StructuredFileResolution,
  StructuredGenerationActivation,
  StructuredGenerationStage,
  StructuredIndexCounts,
  StructuredIndexState,
  StructuredPendingClear,
  StructuredPendingSymbolResolution,
  StructuredReconciliationResult,
  StructuredSymbolResolution,
  StructuredTombstone,
} from '../../../src/storage/interfaces/structured-catalog.js';
import type { StructuredDeclaration } from '../../../src/structured/contracts.js';

export class InMemoryMetadataStore implements IMetadataStore, IStructuredCatalog {
  private readonly nodes = new Map<string, MerkleNodeRow>();

  private stats: IndexStatsRow | null = null;

  private readonly deadLetterEntries = new Map<string, DeadLetterEntry>();

  private readonly embeddings = new Map<string, number[]>();

  private readonly active = new Map<string, StructuredGenerationStage>();

  private readonly pending = new Map<string, StructuredGenerationStage>();

  private readonly tombstones = new Map<string, StructuredTombstone>();

  private rebuildEpoch = 0;

  async initialize(): Promise<void> {
    return;
  }

  async bootstrapStructuredSchema(): Promise<void> {}

  async getStructuredIndexState(): Promise<StructuredIndexState> {
    return { schemaVersion: null, rebuildState: null, rebuildEpoch: this.rebuildEpoch, lastErrorCode: null, counts: await this.getStructuredCounts(), activeGenerations: await this.getActiveGenerationMap([...this.active.keys()]) };
  }

  async stageGeneration(input: StructuredGenerationStage): Promise<void> {
    this.pending.set(input.filePath, input);
  }

  async activateGeneration(input: StructuredGenerationActivation): Promise<StructuredActivationResult> {
    const pending = this.pending.get(input.filePath);
    const active = this.active.get(input.filePath);
    if (input.expectedRebuildEpoch !== this.rebuildEpoch) return { activated: false, reason: 'stale_rebuild_epoch' };
    if ((active?.generation.generationId ?? null) !== input.expectedActiveGeneration) return { activated: false, reason: 'stale_active_generation' };
    if (pending?.generation.generationId !== input.generationId) return { activated: false, reason: 'missing_generation' };
    this.active.set(input.filePath, pending);
    this.pending.delete(input.filePath);
    for (const declaration of pending.declarations) this.tombstones.delete(declaration.symbolId);
    return { activated: true };
  }

  async clearPendingGeneration(input: StructuredPendingClear): Promise<{ cleared: boolean }> {
    const pending = this.pending.get(input.filePath);
    const active = this.active.get(input.filePath);
    if (input.expectedRebuildEpoch !== this.rebuildEpoch || (active?.generation.generationId ?? null) !== input.expectedActiveGeneration || pending?.generation.generationId !== input.expectedPendingGeneration) return { cleared: false };
    this.pending.delete(input.filePath);
    return { cleared: true };
  }

  async retireFile(input: StructuredFileRetirement): Promise<void> {
    const active = this.active.get(input.filePath);
    if (active === undefined || active.generation.generationId !== input.expectedActiveGeneration || input.rebuildEpoch !== this.rebuildEpoch) return;
    for (const declaration of active.declarations) this.tombstones.set(declaration.symbolId, { symbolId: declaration.symbolId, filePath: input.filePath, generationId: active.generation.generationId, retiredAtRebuildEpoch: this.rebuildEpoch, retiredAt: input.tombstoneTimestamp ?? Date.now() });
    this.active.delete(input.filePath);
    this.pending.delete(input.filePath);
  }

  async resolveFile(filePath: string): Promise<StructuredFileResolution> {
    const active = this.active.get(filePath);
    if (active) return { kind: 'active', generationId: active.generation.generationId };
    const pending = this.pending.get(filePath);
    return pending ? { kind: 'pending', generationId: pending.generation.generationId } : { kind: 'missing' };
  }

  async getActiveGenerationMap(filePaths: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return new Map(filePaths.flatMap((filePath) => { const generation = this.active.get(filePath)?.generation.generationId; return generation ? [[filePath, generation] as const] : []; }));
  }

  async resolveSymbol(symbolId: string): Promise<StructuredSymbolResolution> {
    for (const generation of this.active.values()) { const declaration = generation.declarations.find((item) => item.symbolId === symbolId); if (declaration) return { kind: 'active', declaration }; }
    const tombstone = this.tombstones.get(symbolId);
    return tombstone ? { kind: 'tombstone', tombstone } : { kind: 'missing' };
  }

  async getPendingSymbol(symbolId: string): Promise<StructuredPendingSymbolResolution> {
    for (const generation of this.pending.values()) { const declaration = generation.declarations.find((item) => item.symbolId === symbolId); if (declaration) return { kind: 'pending', declaration }; }
    return { kind: 'missing' };
  }

  async getTombstone(symbolId: string): Promise<StructuredTombstone | null> { return this.tombstones.get(symbolId) ?? null; }

  async getStructuredCounts(): Promise<StructuredIndexCounts> {
    return { activeFiles: this.active.size, activeSymbols: [...this.active.values()].reduce((sum, item) => sum + item.declarations.length, 0), pendingFiles: this.pending.size, pendingSymbols: [...this.pending.values()].reduce((sum, item) => sum + item.declarations.length, 0), tombstones: this.tombstones.size };
  }

  async reconcileStructuredState(): Promise<StructuredReconciliationResult> { return { repaired: false, prunedTombstones: 0 }; }

  async bulkUpsertMerkleNodes(nodes: MerkleNodeRow[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.path, node);
    }
  }

  async bulkDeleteMerkleNodes(paths: string[]): Promise<void> {
    for (const targetPath of paths) {
      this.nodes.delete(targetPath);
    }
  }

  async bulkDeleteSubtrees(paths: string[]): Promise<number> {
    let totalDeleted = 0;
    for (const pathPrefix of paths) {
      totalDeleted += await this.deleteSubtree(pathPrefix);
    }
    return totalDeleted;
  }

  async deleteSubtree(pathPrefix: string): Promise<number> {
    const normalizedPrefix = `${pathPrefix}/`;
    let deleted = 0;

    for (const key of [...this.nodes.keys()]) {
      if (key === pathPrefix || key.startsWith(normalizedPrefix)) {
        this.nodes.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }

  async getSubtreePaths(pathPrefix: string): Promise<string[]> {
    const normalizedPrefix = `${pathPrefix}/`;
    const paths: string[] = [];

    for (const key of this.nodes.keys()) {
      if (key === pathPrefix || key.startsWith(normalizedPrefix)) {
        paths.push(key);
      }
    }

    return paths;
  }

  async pruneEmptyParents(
    path: string,
    pathExists: (targetPath: string) => Promise<boolean>,
  ): Promise<void> {
    let currentPath = dirname(path);

    while (currentPath !== '.' && currentPath !== '/' && currentPath !== '') {
      const hasChildren = await this.hasChildren(currentPath);
      if (!hasChildren) {
        if (await pathExists(currentPath)) {
          break;
        }
        this.nodes.delete(currentPath);
        currentPath = dirname(currentPath);
      } else {
        break;
      }
    }
  }

  async renamePath(oldPath: string, newPath: string, hash: string): Promise<void> {
    const oldNode = this.nodes.get(oldPath);
    const isDirectory = oldNode?.isDirectory ?? false;

    const parentPath = dirname(newPath);
    const normalizedParentPath = parentPath === '.' || parentPath === '/' || parentPath === '' ? null : parentPath;

    this.nodes.delete(oldPath);
    this.nodes.set(newPath, {
      path: newPath,
      hash,
      parentPath: normalizedParentPath,
      isDirectory,
    });
  }


  async getMerkleNode(path: string): Promise<MerkleNodeRow | null> {
    return this.nodes.get(path) ?? null;
  }

  async getChildren(path: string | null): Promise<MerkleNodeRow[]> {
    return [...this.nodes.values()]
      .filter((node) => node.parentPath === path)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async hasChildren(path: string | null): Promise<boolean> {
    for (const node of this.nodes.values()) {
      if (node.parentPath === path) {
        return true;
      }
    }
    return false;
  }

  async getAllNodes(): Promise<MerkleNodeRow[]> {
    return [...this.nodes.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  async getAllFileNodes(): Promise<MerkleNodeRow[]> {
    return [...this.nodes.values()]
      .filter((node) => !node.isDirectory)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async getAllPaths(): Promise<string[]> {
    return [...this.nodes.keys()].sort((left, right) => left.localeCompare(right));
  }

  async getIndexStats(): Promise<IndexStatsRow | null> {
    return this.stats;
  }

  async setIndexStats(stats: IndexStatsRow): Promise<void> {
    this.stats = stats;
  }

  async atomicCompletionCheck(stats: IndexStatsRow): Promise<{
    dlqEmpty: boolean;
    dlqEntries: DeadLetterEntry[];
  }> {
    const dlqEntries = await this.getDeadLetterEntries();
    if (dlqEntries.length === 0) {
      this.stats = stats;
    }
    return { dlqEmpty: dlqEntries.length === 0, dlqEntries };
  }

  async upsertDeadLetterEntries(entries: DeadLetterEntry[]): Promise<void> {
    for (const entry of entries) {
      this.deadLetterEntries.set(entry.id, entry);
    }
  }

  async removeDeadLetterEntries(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.deadLetterEntries.delete(id);
    }
  }

  async getDeadLetterEntries(): Promise<DeadLetterEntry[]> {
    return [...this.deadLetterEntries.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getEmbeddings(hashes: string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    for (const hash of hashes) {
      const vector = this.embeddings.get(hash);
      if (vector !== undefined) {
        result.set(hash, [...vector]);
      }
    }
    return result;
  }

  async setEmbeddings(entries: EmbeddingCacheEntry[]): Promise<void> {
    for (const entry of entries) {
      this.embeddings.set(entry.hash, [...entry.vector]);
    }
  }

  async deleteEmbeddings(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      this.embeddings.delete(hash);
    }
  }

  async clearEmbeddings(): Promise<void> {
    this.embeddings.clear();
  }

  async pruneEmbeddings(_maxAgeDays: number): Promise<number> {
    // In-memory store has no persistent TTL concern for tests
    return 0;
  }
}
