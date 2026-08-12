/** Storage interfaces (design doc §7.3). Canonical home since the Phase 1b relocation; re-exported from src/types/index.ts for backward compatibility. */
import type { DeadLetterEntry } from '../../types/index.js';

export interface MerkleNodeRow {
  path: string;
  hash: string;
  parentPath: string | null;
  isDirectory: boolean;
}

export interface IndexStatsRow {
  id: 'primary';
  totalFiles: number;
  totalChunks: number;
  lastIndexedAt: string | null;
  lastFullScanAt: string | null;
  overflowCount: number;
}

export interface EmbeddingCacheEntry {
  hash: string;
  vector: number[];
}

export interface IMetadataStore {
  initialize(): Promise<void>;
  bulkUpsertMerkleNodes(nodes: MerkleNodeRow[]): Promise<void>;
  bulkDeleteMerkleNodes(paths: string[]): Promise<void>;
  bulkDeleteSubtrees(paths: string[]): Promise<number>;
  deleteSubtree(pathPrefix: string): Promise<number>;
  getSubtreePaths(pathPrefix: string): Promise<string[]>;
  pruneEmptyParents(path: string, pathExists: (targetPath: string) => Promise<boolean>): Promise<void>;
  renamePath(oldPath: string, newPath: string, hash: string): Promise<void>;
  getMerkleNode(path: string): Promise<MerkleNodeRow | null>;
  getChildren(path: string | null): Promise<MerkleNodeRow[]>;
  hasChildren(path: string | null): Promise<boolean>;
  getAllNodes(): Promise<MerkleNodeRow[]>;
  getAllFileNodes(): Promise<MerkleNodeRow[]>;
  getAllPaths(): Promise<string[]>;
  getIndexStats(): Promise<IndexStatsRow | null>;
  setIndexStats(stats: IndexStatsRow): Promise<void>;
  upsertDeadLetterEntries(entries: DeadLetterEntry[]): Promise<void>;
  removeDeadLetterEntries(ids: string[]): Promise<void>;
  getDeadLetterEntries(): Promise<DeadLetterEntry[]>;
  getEmbeddings(hashes: string[]): Promise<Map<string, number[]>>;
  setEmbeddings(entries: EmbeddingCacheEntry[]): Promise<void>;
  deleteEmbeddings(hashes: string[]): Promise<void>;
  clearEmbeddings(): Promise<void>;
  pruneEmbeddings(maxAgeDays: number): Promise<number>;
}
