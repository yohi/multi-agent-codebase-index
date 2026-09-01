import type { SymbolRetrievalService } from '../../structured/retrieval-service.js';

export interface GetSymbolSourceToolArgs {
  symbolId: string;
}

export const executeGetSymbolSource = async (
  service: SymbolRetrievalService,
  args: GetSymbolSourceToolArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const result = await service.getSymbolSource({ symbolId: args.symbolId, signal });
  if (result === null || typeof result !== 'object') {
    return { result };
  }
  return result as Record<string, unknown>;
};
