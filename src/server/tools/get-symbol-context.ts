import type { SymbolRetrievalService } from '../../structured/retrieval-service.js';

export interface GetSymbolContextToolArgs {
  symbolId: string;
  tokenBudget: number;
}

export const executeGetSymbolContext = async (
  service: SymbolRetrievalService,
  args: GetSymbolContextToolArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const result = await service.getSymbolContext({ symbolId: args.symbolId, tokenBudget: args.tokenBudget, signal });
  if (result === null || typeof result !== 'object') {
    return { result };
  }
  return result as Record<string, unknown>;
};
