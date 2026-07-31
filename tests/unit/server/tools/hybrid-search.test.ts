import { describe, expect, it, vi } from 'vitest';

import { executeHybridSearch } from '../../../../src/server/tools/hybrid-search.js';
import type { RankedResult, SearchResponse } from '../../../../src/types/index.js';
import { PathTraversalError } from '../../../../src/server/path-sanitizer.js';

class StubOrchestrator {
  public lastSearchArgs?: Record<string, unknown>;

  constructor(private readonly response: SearchResponse) {}

  async search(args: Record<string, unknown>): Promise<SearchResponse> {
    this.lastSearchArgs = args;
    return this.response;
  }
}

const makeResult = (
  overrides: {
    id?: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
  } = {},
): RankedResult => ({
  chunk: {
    id: overrides.id ?? 'chunk-1',
    filePath: overrides.filePath ?? 'src/auth.ts',
    content: 'export function authenticate() {}',
    language: 'typescript',
    symbolKind: 'function',
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 1,
    hash: 'hash-1',
  },
  score: 1,
  source: 'hybrid',
  rank: 1,
  reciprocalRankScore: 1,
});

describe('executeHybridSearch', () => {
  const response: SearchResponse = {
    query: 'authenticate',
    tookMs: 3,
    results: [],
  };

  const sanitizer = {
    validateGlob: (pattern: string) => {
      if (pattern.includes('..')) {
        throw new PathTraversalError(pattern);
      }
      return pattern;
    },
    sanitize: async (filePath: string) => `/sandbox/${filePath}`,
  };

  const unusedLoader = async () => 'unused';

  it('delegates to the orchestrator and validates filePattern', async () => {
    const orchestrator = new StubOrchestrator(response);

    await expect(
      executeHybridSearch(orchestrator as never, sanitizer as never, unusedLoader, {
        query: 'authenticate',
        filePattern: 'src/*.ts',
      }),
    ).resolves.toEqual(response);

    expect(orchestrator.lastSearchArgs).toMatchObject({
      query: 'authenticate',
      filePatterns: ['src/*.ts'],
    });
  });

  it('forwards abortSignal to the orchestrator', async () => {
    const controller = new AbortController();
    const orchestrator = new StubOrchestrator(response);

    await executeHybridSearch(
      orchestrator as never,
      sanitizer as never,
      unusedLoader,
      { query: 'authenticate' },
      controller.signal,
    );

    expect(orchestrator.lastSearchArgs).toEqual({
      query: 'authenticate',
      abortSignal: controller.signal,
    });
  });

  it('rejects directory traversal in filePattern before calling the orchestrator', async () => {
    const orchestrator = new StubOrchestrator(response);

    await expect(
      executeHybridSearch(orchestrator as never, sanitizer as never, unusedLoader, {
        query: 'authenticate',
        filePattern: '../outside',
      }),
    ).rejects.toThrow(PathTraversalError);

    expect(orchestrator.lastSearchArgs).toBeUndefined();
  });

  describe('snippet attachment', () => {
    it('does not attach snippets when includeSnippet is false', async () => {
      const snippetResponse: SearchResponse = {
        query: 'test',
        tookMs: 1,
        results: [makeResult({ startLine: 3, endLine: 3 })],
      };
      const orchestrator = new StubOrchestrator(snippetResponse);
      const loader = async () => 'line1\nline2\nline3\nline4\nline5';

      const result = await executeHybridSearch(
        orchestrator as never,
        sanitizer as never,
        loader,
        { query: 'test', includeSnippet: false },
      );

      expect(result.results[0]?.snippet).toBeUndefined();
      expect(result.results[0]?.snippetStartLine).toBeUndefined();
      expect(result.results[0]?.snippetEndLine).toBeUndefined();
    });

    it('attaches a snippet using the requested contextLines when includeSnippet is true', async () => {
      const snippetResponse: SearchResponse = {
        query: 'test',
        tookMs: 1,
        results: [makeResult({ startLine: 3, endLine: 3 })],
      };
      const orchestrator = new StubOrchestrator(snippetResponse);
      const loader = async () => 'line1\nline2\nline3\nline4\nline5';

      const result = await executeHybridSearch(
        orchestrator as never,
        sanitizer as never,
        loader,
        { query: 'test', includeSnippet: true, contextLines: 1 },
      );

      expect(result.results[0]).toMatchObject({
        snippet: 'line2\nline3\nline4',
        snippetStartLine: 2,
        snippetEndLine: 4,
      });
    });

    it('applies the default contextLines of 3 when contextLines is omitted', async () => {
      const snippetResponse: SearchResponse = {
        query: 'test',
        tookMs: 1,
        results: [makeResult({ startLine: 5, endLine: 5 })],
      };
      const orchestrator = new StubOrchestrator(snippetResponse);
      const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
      const loader = async () => content;

      const result = await executeHybridSearch(
        orchestrator as never,
        sanitizer as never,
        loader,
        { query: 'test', includeSnippet: true },
      );

      expect(result.results[0]).toMatchObject({
        snippet: 'line2\nline3\nline4\nline5\nline6\nline7\nline8',
        snippetStartLine: 2,
        snippetEndLine: 8,
      });
    });

    it('clamps contextLines to the configured maximum of 20', async () => {
      const snippetResponse: SearchResponse = {
        query: 'test',
        tookMs: 1,
        results: [makeResult({ startLine: 25, endLine: 25 })],
      };
      const orchestrator = new StubOrchestrator(snippetResponse);
      const content = Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n');
      const loader = async () => content;

      const result = await executeHybridSearch(
        orchestrator as never,
        sanitizer as never,
        loader,
        { query: 'test', includeSnippet: true, contextLines: 50 },
      );

      expect(result.results[0]).toMatchObject({
        snippetStartLine: 5,
        snippetEndLine: 45,
      });
    });

    it('loads file content only once when multiple results share the same file', async () => {
      const snippetResponse: SearchResponse = {
        query: 'test',
        tookMs: 1,
        results: [
          makeResult({ id: 'a', startLine: 3, endLine: 3 }),
          makeResult({ id: 'b', startLine: 10, endLine: 10 }),
        ],
      };
      const orchestrator = new StubOrchestrator(snippetResponse);
      const content = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
      let callCount = 0;
      const loader = async () => {
        callCount += 1;
        return content;
      };

      const result = await executeHybridSearch(
        orchestrator as never,
        sanitizer as never,
        loader,
        { query: 'test', includeSnippet: true, contextLines: 1 },
      );

      expect(callCount).toBe(1);
      expect(result.results[0]?.snippet).toBeDefined();
      expect(result.results[1]?.snippet).toBeDefined();
    });

    it('records merged snippet line ranges once across all successfully loaded files', async () => {
      const snippetResponse: SearchResponse = {
        query: 'test',
        tookMs: 1,
        results: [
          makeResult({ id: 'shared-a', filePath: 'src/shared.ts', startLine: 3, endLine: 4 }),
          makeResult({ id: 'shared-b', filePath: 'src/shared.ts', startLine: 5, endLine: 6 }),
          makeResult({ id: 'other', filePath: 'src/other.ts', startLine: 8, endLine: 8 }),
        ],
      };
      const orchestrator = new StubOrchestrator(snippetResponse);
      const content = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join('\n');
      const metricsHooks = { onContextLinesFetched: vi.fn() };

      await executeHybridSearch(
        orchestrator as never,
        sanitizer as never,
        async () => content,
        { query: 'test', includeSnippet: true, contextLines: 1 },
        undefined,
        metricsHooks,
      );

      expect(metricsHooks.onContextLinesFetched).toHaveBeenCalledTimes(1);
      expect(metricsHooks.onContextLinesFetched).toHaveBeenCalledWith('hybrid_search', 9);
    });

    it('sanitizes file path only once when multiple results share the same filePath', async () => {
      const snippetResponse: SearchResponse = {
        query: 'test',
        tookMs: 1,
        results: [
          makeResult({ id: 'a', filePath: 'src/auth.ts', startLine: 3, endLine: 3 }),
          makeResult({ id: 'b', filePath: 'src/auth.ts', startLine: 10, endLine: 10 }),
        ],
      };
      const orchestrator = new StubOrchestrator(snippetResponse);
      const content = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
      let sanitizeCallCount = 0;
      const countingSanitizer = {
        validateGlob: (pattern: string) => {
          if (pattern.includes('..')) {
            throw new PathTraversalError(pattern);
          }
          return pattern;
        },
        sanitize: async (filePath: string) => {
          sanitizeCallCount += 1;
          return `/sandbox/${filePath}`;
        },
      };
      const loader = async () => content;

      const result = await executeHybridSearch(
        orchestrator as never,
        countingSanitizer as never,
        loader,
        { query: 'test', includeSnippet: true, contextLines: 1 },
      );

      expect(sanitizeCallCount).toBe(1);
      expect(result.results[0]?.snippet).toBeDefined();
      expect(result.results[1]?.snippet).toBeDefined();
    });

    it('does not start a snippet file read after the request is aborted', async () => {
      const snippetResponse: SearchResponse = {
        query: 'test',
        tookMs: 1,
        results: [
          makeResult({ id: 'first', filePath: 'src/first.ts', startLine: 3, endLine: 3 }),
          makeResult({ id: 'second', filePath: 'src/second.ts', startLine: 3, endLine: 3 }),
        ],
      };
      const orchestrator = new StubOrchestrator(snippetResponse);
      const controller = new AbortController();
      const abortingSanitizer = {
        ...sanitizer,
        sanitize: async (filePath: string) => {
          controller.abort();
          return `/sandbox/${filePath}`;
        },
      };
      const loader = vi.fn(async () => 'line1\nline2\nline3\nline4\nline5');

      await executeHybridSearch(
        orchestrator as never,
        abortingSanitizer as never,
        loader,
        { query: 'test', includeSnippet: true, contextLines: 1 },
        controller.signal,
      );

      expect(loader).not.toHaveBeenCalled();
    });

    it('skips snippet fields for a result when file loading fails, while preserving the result', async () => {
      const snippetResponse: SearchResponse = {
        query: 'test',
        tookMs: 1,
        results: [makeResult({ startLine: 3, endLine: 3 })],
      };
      const orchestrator = new StubOrchestrator(snippetResponse);
      const loader = async () => {
        throw new Error('file load failed');
      };

      const result = await executeHybridSearch(
        orchestrator as never,
        sanitizer as never,
        loader,
        { query: 'test', includeSnippet: true },
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.snippet).toBeUndefined();
      expect(result.results[0]?.snippetStartLine).toBeUndefined();
      expect(result.results[0]?.snippetEndLine).toBeUndefined();
    });

    it('does not fail the whole search when sanitizing one chunk path throws', async () => {
      const snippetResponse: SearchResponse = {
        query: 'test',
        tookMs: 1,
        results: [
          makeResult({ id: 'bad', filePath: '../outside.ts', startLine: 1, endLine: 1 }),
          makeResult({ id: 'good', filePath: 'src/auth.ts', startLine: 3, endLine: 3 }),
        ],
      };
      const orchestrator = new StubOrchestrator(snippetResponse);
      const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
      const throwingSanitizer = {
        ...sanitizer,
        sanitize: async (filePath: string) => {
          if (filePath.includes('..')) {
            throw new PathTraversalError(filePath);
          }
          return `/sandbox/${filePath}`;
        },
      };
      const loader = async () => content;

      const result = await executeHybridSearch(
        orchestrator as never,
        throwingSanitizer as never,
        loader,
        { query: 'test', includeSnippet: true, contextLines: 1 },
      );

      expect(result.results).toHaveLength(2);
      expect(result.results.find((r) => r.chunk.id === 'bad')?.snippet).toBeUndefined();
      expect(result.results.find((r) => r.chunk.id === 'good')?.snippet).toBeDefined();
    });
  });
});
