import type { MetricsHooks } from '../../observability/types.js';
import type { SymbolRetrievalService } from '../../structured/retrieval-service.js';

export interface GetFileOutlineToolArgs {
  filePath: string;
}

export const executeGetFileOutline = async (
  service: SymbolRetrievalService,
  args: GetFileOutlineToolArgs,
  signal?: AbortSignal,
  metricsHooks?: MetricsHooks,
): Promise<Record<string, unknown>> => {
  const result = await service.getFileOutline({ filePath: args.filePath, signal });
  if (result === null || typeof result !== 'object') {
    metricsHooks?.onStructuredRetrievalOutcome?.('get_file_outline', 'error');
    return { result };
  }
  const status = (result as Record<string, unknown>).status as string | undefined;
  metricsHooks?.onStructuredRetrievalOutcome?.('get_file_outline', status ?? 'unknown');
  return result as Record<string, unknown>;
};
