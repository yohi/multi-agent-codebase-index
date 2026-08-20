import type { NeutralSchema } from './schemas-neutral.js';

export type ToolName =
  | 'semantic_search'
  | 'grep_search'
  | 'hybrid_search'
  | 'get_context'
  | 'index_status'
  | 'reindex';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  input: NeutralSchema;
}

export const SEMANTIC_SEARCH_DEFINITION: ToolDefinition = {
  name: 'semantic_search',
  description: 'Vector-only semantic search; prefer hybrid_search for most tasks.',
  input: {
    query: { kind: 'string' },
    topK: { kind: 'integer', optional: true, maximum: 100 },
    filePattern: { kind: 'string', optional: true },
    filePatterns: { kind: 'stringArray', optional: true },
    language: { kind: 'string', optional: true },
  },
};

export const GREP_SEARCH_DEFINITION: ToolDefinition = {
  name: 'grep_search',
  description: 'Exact string search for symbols, errors, or code fragments.',
  input: {
    pattern: { kind: 'string' },
    filePattern: { kind: 'string', optional: true },
    filePatterns: { kind: 'stringArray', optional: true },
    caseSensitive: { kind: 'boolean', optional: true },
    maxResults: { kind: 'integer', optional: true, maximum: 1000 },
  },
};

export const HYBRID_SEARCH_DEFINITION: ToolDefinition = {
  name: 'hybrid_search',
  description: 'Semantic + grep hybrid search for vague or conceptual queries.',
  input: {
    query: { kind: 'string' },
    topK: { kind: 'integer', optional: true, maximum: 100 },
    filePattern: { kind: 'string', optional: true },
    filePatterns: { kind: 'stringArray', optional: true },
    language: { kind: 'string', optional: true },
    grepPattern: { kind: 'string', optional: true },
    includeSnippet: { kind: 'boolean', optional: true },
    contextLines: {
      kind: 'integer',
      optional: true,
      maximum: 20,
      description:
        'Lines of context to include before and after each match when includeSnippet is true. Maximum 20; values above 20 are rejected.',
    },
  },
};

export const GET_CONTEXT_DEFINITION: ToolDefinition = {
  name: 'get_context',
  description: 'Return a specific line range from a file; prefer partial reads.',
  input: {
    filePath: { kind: 'string' },
    symbolName: { kind: 'string', optional: true },
    startLine: { kind: 'integer', optional: true },
    endLine: { kind: 'integer', optional: true },
    mode: {
      kind: 'enum',
      values: ['eager', 'deferred'],
      optional: true,
      default: 'eager',
      description:
        'Set to "deferred" to receive a short preview and hint instead of full content for large files.',
    },
  },
};

export const INDEX_STATUS_DEFINITION: ToolDefinition = {
  name: 'index_status',
  description: 'Check indexing progress and statistics before searching.',
  input: {},
};

export const REINDEX_DEFINITION: ToolDefinition = {
  name: 'reindex',
  description: 'Manually rebuild the local search index.',
  input: {
    fullRebuild: { kind: 'boolean', optional: true },
    reason: {
      kind: 'enum',
      values: ['manual', 'overflow-recovery', 'startup-reconciliation'],
      optional: true,
    },
  },
};

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  SEMANTIC_SEARCH_DEFINITION,
  GREP_SEARCH_DEFINITION,
  HYBRID_SEARCH_DEFINITION,
  GET_CONTEXT_DEFINITION,
  INDEX_STATUS_DEFINITION,
  REINDEX_DEFINITION,
];
