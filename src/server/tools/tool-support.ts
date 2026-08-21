import { sanitizeErrorMessage } from '../../utils/error-utils.js';
import type { IContentStore } from '../../storage/interfaces/content-store.js';
import { withToolMetrics } from '../tool-instrumentation.js';
import { executeGetContext } from './get-context.js';
import type { GetContextToolArgs } from './get-context-schema.js';
import { executeGrepSearch, type GrepSearchToolArgs } from './grep-search.js';
import { executeHybridSearch, type HybridSearchToolArgs } from './hybrid-search.js';
import { executeIndexStatus } from './index-status.js';
import { executeReindex } from './reindex.js';
import { executeSemanticSearch, type SemanticSearchToolArgs } from './semantic-search.js';
import type { ToolName } from './registry/definitions.js';
import type { NexusServerOptions, ToolHandler } from './types.js';

export const errorResult = (error: unknown) => {
  const errorMessage = sanitizeErrorMessage(error);
  console.error('[Nexus Server Error]', errorMessage);

  return {
    content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }],
    isError: true,
    structuredContent: { error: true, message: errorMessage },
  };
};

export const toolResult = <T extends object>(structuredContent: T) => {
  try {
    const normalized: unknown = JSON.parse(
      JSON.stringify(structuredContent, (_key: string, value: unknown): unknown =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    );

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(normalized, null, 2) }],
      structuredContent: normalized as Record<string, unknown>,
    };
  } catch (error) {
    const errorMessage = sanitizeErrorMessage(error);
    console.error('[Nexus Serialization Error]', error);
    return {
      content: [{ type: 'text' as const, text: `Failed to serialize structuredContent: ${errorMessage}` }],
      isError: true,
      structuredContent: {
        error: true,
        message: errorMessage,
        originalType: typeof structuredContent,
      },
    };
  }
};

export const createContentReader = (
  contentStore: IContentStore | undefined,
  fallback: (filePath: string, signal?: AbortSignal) => Promise<string>,
): ((filePath: string, startLine?: number, endLine?: number, signal?: AbortSignal) => Promise<string>) => {
  if (contentStore === undefined) {
    return async (filePath, startLine = 1, endLine = Number.MAX_SAFE_INTEGER, signal) => {
      const content = await fallback(filePath, signal);
      const lines = content.split('\n');
      const clampedStart = Math.max(1, Math.min(startLine, lines.length));
      const clampedEnd = Math.max(1, Math.min(endLine, lines.length));
      if (clampedStart > clampedEnd) {
        throw new Error(`Invalid line range: startLine (${clampedStart}) is greater than endLine (${clampedEnd})`);
      }
      return lines.slice(clampedStart - 1, clampedEnd).join('\n');
    };
  }
  return async (filePath, startLine = 1, endLine = Number.MAX_SAFE_INTEGER, signal): Promise<string> => {
    try {
      return await contentStore.readRange(filePath, startLine, endLine, signal);
    } catch (error) {
      console.warn('[Nexus] ContentStore readRange failed; falling back to filesystem read:', error);
      const content = await fallback(filePath, signal);
      const lines = content.split('\n');
      const clampedStart = Math.max(1, Math.min(startLine, lines.length));
      const clampedEnd = Math.max(1, Math.min(endLine, lines.length));
      if (clampedStart > clampedEnd) {
        throw new Error(`Invalid line range: startLine (${clampedStart}) is greater than endLine (${clampedEnd})`);
      }
      return lines.slice(clampedStart - 1, clampedEnd).join('\n');
    }
  };
};

export const buildToolHandlers = (
  options: NexusServerOptions,
  awaitInitialize?: () => Promise<void>,
): Record<ToolName, ToolHandler> => {
  const readContent = createContentReader(options.contentStore, options.loadFileContent);

  return {
    semantic_search: withToolMetrics(
      'semantic_search',
      options.metricsHooks,
      async (args: unknown, extra?: { signal?: AbortSignal }) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeSemanticSearch(
            options.semanticSearch,
            options.sanitizer,
            args as SemanticSearchToolArgs & { filePattern?: string },
            extra?.signal,
          );
          options.metricsHooks?.onSearchResults('semantic', result.results.length);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    ),
    grep_search: withToolMetrics(
      'grep_search',
      options.metricsHooks,
      async (args: unknown, extra?: { signal?: AbortSignal }) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeGrepSearch(
            options.grepEngine,
            options.projectRoot,
            options.sanitizer,
            args as GrepSearchToolArgs,
            extra?.signal,
          );
          options.metricsHooks?.onSearchResults('grep', result.matches.length);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    ),
    hybrid_search: withToolMetrics(
      'hybrid_search',
      options.metricsHooks,
      async (args: unknown, extra?: { signal?: AbortSignal }) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeHybridSearch(
            options.orchestrator,
            options.sanitizer,
            (filePath) => readContent(filePath, 1, Number.MAX_SAFE_INTEGER, extra?.signal),
            args as HybridSearchToolArgs & { filePattern?: string },
            extra?.signal,
            options.metricsHooks,
          );
          options.metricsHooks?.onSearchResults('hybrid', result.results.length);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    ),
    get_context: withToolMetrics(
      'get_context',
      options.metricsHooks,
      async (args: unknown, extra?: { signal?: AbortSignal }) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeGetContext(
            readContent,
            options.sanitizer,
            args as GetContextToolArgs,
            extra?.signal,
          );
          const lineCount = 'mode' in result
            ? result.previewEndLine - result.previewStartLine + 1
            : result.endLine - result.startLine + 1;
          options.metricsHooks?.onContextLinesFetched('get_context', lineCount);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    ),
    index_status: withToolMetrics(
      'index_status',
      options.metricsHooks,
      async () => {
        if (awaitInitialize) await awaitInitialize();
        try {
          return toolResult(
            await executeIndexStatus(
              options.metadataStore,
              options.vectorStore,
              options.pluginRegistry,
              options.pipeline,
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    ),
    reindex: withToolMetrics(
      'reindex',
      options.metricsHooks,
      async (args: unknown) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          return toolResult(
            await executeReindex(
              options.pipeline,
              options.runReindex,
              options.loadFileContent,
              args as Parameters<typeof executeReindex>[3],
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    ),
  };
};
