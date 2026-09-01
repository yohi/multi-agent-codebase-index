import type { SymbolRetrievalService } from '../../structured/retrieval-service.js';

export interface GetFileOutlineToolArgs {
  filePath: string;
}

export const executeGetFileOutline = async (
  service: SymbolRetrievalService,
  args: GetFileOutlineToolArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const result = await service.getFileOutline({ filePath: args.filePath, signal });
  if (result === null || typeof result !== 'object') {
    return { result };
  }
  return result as Record<string, unknown>;
};
