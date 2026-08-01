import type { SearchResponse } from '../../types/index.js';
import type { HybridSearchParams, SearchOrchestrator } from '../../search/orchestrator.js';
import type { MetricsHooks } from '../../observability/types.js';
import type { PathSanitizer } from '../path-sanitizer.js';
import { resolveLineRange, sliceContent, type LineRange } from './context-helpers.js';

export interface HybridSearchToolArgs extends HybridSearchParams {
  includeSnippet?: boolean;
  contextLines?: number;
}

const DEFAULT_CONTEXT_LINES = 3;
const MAX_CONTEXT_LINES = 20;

const countMergedLineRanges = (ranges: readonly LineRange[]): number => {
  const sortedRanges = [...ranges].sort(
    (left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
  );
  let totalLines = 0;
  let currentRange: LineRange | undefined;

  for (const range of sortedRanges) {
    if (currentRange === undefined) {
      currentRange = { ...range };
      continue;
    }

    if (range.startLine <= currentRange.endLine + 1) {
      currentRange.endLine = Math.max(currentRange.endLine, range.endLine);
      continue;
    }

    totalLines += currentRange.endLine - currentRange.startLine + 1;
    currentRange = { ...range };
  }

  return currentRange === undefined
    ? totalLines
    : totalLines + currentRange.endLine - currentRange.startLine + 1;
};

export const executeHybridSearch = async (
  orchestrator: SearchOrchestrator,
  sanitizer: PathSanitizer,
  loadFileContent: (filePath: string) => Promise<string>,
  args: HybridSearchToolArgs & { filePattern?: string },
  abortSignal?: AbortSignal,
  metricsHooks?: Pick<MetricsHooks, 'onContextLinesFetched'>,
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
    metricsHooks?.onContextLinesFetched('hybrid_search', 0);
    return response;
  }

  const contextLines = Math.min(rawContextLines ?? DEFAULT_CONTEXT_LINES, MAX_CONTEXT_LINES);
  const fileContentCache = new Map<string, string | null>();
  const sanitizedPathCache = new Map<string, string | null>();
  const snippetRangesByFile = new Map<string, LineRange[]>();

  for (const result of response.results) {
    if (abortSignal?.aborted) {
      break;
    }

    let sanitizedPath: string | null;
    const cachedSanitizedPath = sanitizedPathCache.get(result.chunk.filePath);
    if (cachedSanitizedPath !== undefined) {
      sanitizedPath = cachedSanitizedPath;
    } else {
      try {
        sanitizedPath = await sanitizer.sanitize(result.chunk.filePath);
      } catch {
        // Cannot resolve this chunk's file path; skip its snippet without
        // aborting the rest of the search results.
        sanitizedPath = null;
      }
      sanitizedPathCache.set(result.chunk.filePath, sanitizedPath);
    }

    if (abortSignal?.aborted) {
      break;
    }

    if (sanitizedPath === null) {
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

    if (abortSignal?.aborted) {
      break;
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
    const ranges = snippetRangesByFile.get(sanitizedPath);
    if (ranges) {
      ranges.push(range);
    } else {
      snippetRangesByFile.set(sanitizedPath, [range]);
    }
  }

  const uniqueLineCount = [...snippetRangesByFile.values()].reduce(
    (total, ranges) => total + countMergedLineRanges(ranges),
    0,
  );
  metricsHooks?.onContextLinesFetched('hybrid_search', uniqueLineCount);

  return response;
};
