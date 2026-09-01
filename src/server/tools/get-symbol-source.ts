import type { MetricsHooks } from '../../observability/types.js';
import type { SymbolRetrievalService } from '../../structured/retrieval-service.js';

export interface GetSymbolSourceToolArgs {
  symbolId: string;
}

export const executeGetSymbolSource = async (
  service: SymbolRetrievalService,
  args: GetSymbolSourceToolArgs,
  signal?: AbortSignal,
  metricsHooks?: MetricsHooks,
): Promise<Record<string, unknown>> => {
  const result = await service.getSymbolSource({ symbolId: args.symbolId, signal });
  if (result === null || typeof result !== 'object') {
    metricsHooks?.onStructuredRetrievalOutcome?.('get_symbol_source', 'error');
    return { result };
  }
  const status = (result as Record<string, unknown>).status as string | undefined;
  metricsHooks?.onStructuredRetrievalOutcome?.('get_symbol_source', status ?? 'unknown');
  return result as Record<string, unknown>;
};
