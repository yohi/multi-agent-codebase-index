/** Storage interfaces (design doc §7.3). Canonical home since the Phase 1b relocation; re-exported from src/types/index.ts for backward compatibility. */
import type { CodeChunk, SymbolKind } from '../../types/index.js';

export interface VectorFilter {
  filePathPrefix?: string;
  language?: string;
  symbolKind?: SymbolKind;
}

export interface VectorSearchResult {
  chunk: CodeChunk;
  score: number;
}

export interface VectorStoreStats {
  totalChunks: number;
  totalFiles: number;
  dimensions: number;
  fragmentationRatio: number;
  lastCompactedAt?: string;
}

export interface CompactionResult {
  compacted: boolean;
  fragmentationRatioBefore: number;
  fragmentationRatioAfter: number;
  chunksRemoved: number;
}

export interface CompactionConfig {
  fragmentationThreshold: number;
  minStaleChunks: number;
  idleDelayMs: number;
}

export interface CompactionMutex {
  waitForUnlock(abortSignal?: AbortSignal): Promise<void>;
}

export interface IVectorStore {
  initialize(): Promise<void>;
  upsertChunks(chunks: CodeChunk[], embeddings?: number[][], affectedFilePaths?: string[]): Promise<void>;
  deleteByFilePath(filePath: string): Promise<number>;
  deleteByPathPrefix(pathPrefix: string): Promise<number>;
  renameFilePath(oldPath: string, newPath: string): Promise<number>;
  search(queryVector: number[], topK: number, filter?: VectorFilter): Promise<VectorSearchResult[]>;
  compactIfNeeded(config?: Partial<CompactionConfig>): Promise<CompactionResult>;
  compactAfterReindex(config?: Partial<CompactionConfig>): Promise<CompactionResult>;
  scheduleIdleCompaction(
    runCompaction: () => Promise<void>,
    delayMs?: number,
    mutex?: CompactionMutex,
    abortSignal?: AbortSignal,
    mutexTimeoutMs?: number,
  ): NodeJS.Timeout;
  getStats(): Promise<VectorStoreStats>;
  close(timeoutMs?: number): Promise<void>;
}
