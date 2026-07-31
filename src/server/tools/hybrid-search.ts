import type { SearchResponse } from '../../types/index.js';
import type { HybridSearchParams, SearchOrchestrator } from '../../search/orchestrator.js';
import type { PathSanitizer } from '../path-sanitizer.js';
import { resolveLineRange, sliceContent } from './context-helpers.js';

export interface HybridSearchToolArgs extends HybridSearchParams {
  includeSnippet?: boolean;
  contextLines?: number;
}

const DEFAULT_CONTEXT_LINES = 3;
const MAX_CONTEXT_LINES = 20;

export const executeHybridSearch = async (
  orchestrator: SearchOrchestrator,
  sanitizer: PathSanitizer,
  loadFileContent: (filePath: string) => Promise<string>,
  args: HybridSearchToolArgs & { filePattern?: string },
  abortSignal?: AbortSignal,
): Promise<SearchResponse> => {
  const { filePattern, includeSnippet, contextLines: rawContextLines, ...rest } = args;
  const validatedArgs: HybridSearchParams = { ...rest };

  if (filePattern) {
    validatedArgs.filePatterns = [sanitizer.validateGlob(filePattern)];
  } else if (args.filePatterns) {
    validatedArgs.filePatterns = args.filePatterns.map((p) => sanitizer.validateGlob(p));
  }

  const response = await orchestrator.search({ ...validatedArgs, abortSignal });

  if (!includeSnippet) {
    return response;
  }

  const contextLines = Math.min(rawContextLines ?? DEFAULT_CONTEXT_LINES, MAX_CONTEXT_LINES);
  const fileContentCache = new Map<string, string | null>();

  for (const result of response.results) {
    let sanitizedPath: string;
    try {
      sanitizedPath = await sanitizer.sanitize(result.chunk.filePath);
    } catch {
      // Cannot resolve this chunk's file path; skip its snippet without
      // aborting the rest of the search results.
      continue;
    }

    let content = fileContentCache.get(sanitizedPath);
    if (content === undefined) {
      try {
        content = await loadFileContent(sanitizedPath);
      } catch {
        content = null;
      }
      fileContentCache.set(sanitizedPath, content);
    }

    if (content === null) {
      continue;
    }

    const lines = content.split('\n');
    const range = resolveLineRange(
      lines.length,
      Math.max(1, result.chunk.startLine - contextLines),
      Math.min(lines.length, result.chunk.endLine + contextLines),
    );

    if (range === null) {
      continue;
    }

    result.snippet = sliceContent(content, range);
    result.snippetStartLine = range.startLine;
    result.snippetEndLine = range.endLine;
  }

  return response;
};
