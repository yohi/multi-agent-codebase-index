import type { MetricsHooks } from '../../observability/types.js';
import type { SymbolRetrievalService } from '../../structured/retrieval-service.js';

export interface GetSymbolContextToolArgs {
  symbolId: string;
  tokenBudget: number;
}

export const executeGetSymbolContext = async (
  service: SymbolRetrievalService,
  args: GetSymbolContextToolArgs,
  signal?: AbortSignal,
  metricsHooks?: MetricsHooks,
): Promise<Record<string, unknown>> => {
  const result = await service.getSymbolContext({ symbolId: args.symbolId, tokenBudget: args.tokenBudget, signal });
  if (result === null || typeof result !== 'object') {
    metricsHooks?.onStructuredRetrievalOutcome?.('get_symbol_context', 'error');
    return { result };
  }
  const status = (result as Record<string, unknown>).status as string | undefined;
  metricsHooks?.onStructuredRetrievalOutcome?.('get_symbol_context', status ?? 'unknown');
  if (status === 'ok') {
    const budget = (result as Record<string, unknown>).budget as Record<string, number> | undefined;
    if (budget) {
      metricsHooks?.onStructuredContextTokens?.('get_symbol_context', budget.requested ?? -1, budget.actual ?? -1);
      if ((budget.exceeded ?? false) && (budget.omittedForBudget ?? 0) > 0) {
        metricsHooks?.onStructuredBudgetOverflow?.('get_symbol_context', budget.omittedForBudget ?? 0);
      }
    }
  }
  return result as Record<string, unknown>;
};
