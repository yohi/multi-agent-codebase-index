import { describe, expect, it, vi } from 'vitest';

import { OpenAICompatEmbeddingProvider, EmbedError } from '../../../../src/plugins/embeddings/openai-compat.js';
import { RetryExhaustedError, DimensionMismatchError } from '../../../../src/types/index.js';

describe('OpenAICompatEmbeddingProvider', () => {
  const mockConfig = {
    baseUrl: 'https://api.openai.com',
    apiKey: 'sk-test-key',
    model: 'text-embedding-3-small',
    dimensions: 2,
    maxConcurrency: 1,
    batchSize: 2,
    retryCount: 3,
    retryBaseDelayMs: 10,
  };

  it('embeds texts successfully via OpenAI API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [0.1, 0.2] },
          { embedding: [0.3, 0.4] },
        ],
      }),
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const result = await provider.embed(['text1', 'text2']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(mockFetch).toHaveBeenCalledOnce();
    
    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe('https://api.openai.com/v1/embeddings');
    expect(callArgs[1].headers).toHaveProperty('authorization', 'Bearer sk-test-key');
    expect(JSON.parse(callArgs[1].body as string)).toEqual({
      model: 'text-embedding-3-small',
      input: ['text1', 'text2'],
      dimensions: 2,
    });
  });

  it('uses full path as target URL when baseUrl contains a pathname', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }],
      }),
    });

    // Test with full path https://xxx.com/v1/embeddings
    const providerV1Embeddings = new OpenAICompatEmbeddingProvider(
      { ...mockConfig, baseUrl: 'https://xxx.com/v1/embeddings' },
      { fetch: mockFetch, sleep: vi.fn() },
    );
    await providerV1Embeddings.embed(['test']);
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://xxx.com/v1/embeddings');

    mockFetch.mockClear();

    // Test with full path https://xxx.com/embeddings (e.g. TrueFoundry)
    const providerEmbeddings = new OpenAICompatEmbeddingProvider(
      { ...mockConfig, baseUrl: 'https://gateway.truefoundry.ai/embeddings' },
      { fetch: mockFetch, sleep: vi.fn() },
    );
    await providerEmbeddings.embed(['test']);
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://gateway.truefoundry.ai/embeddings');
  });

  it('sends custom headers if configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }],
      }),
    });

    const provider = new OpenAICompatEmbeddingProvider(
      {
        ...mockConfig,
        headers: {
          'x-portkey-api-key': 'portkey-key',
          'x-portkey-config': 'portkey-config',
        },
      },
      {
        fetch: mockFetch,
        sleep: vi.fn(),
      },
    );

    await provider.embed(['test']);

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(callArgs[1].headers).toMatchObject({
      'authorization': 'Bearer sk-test-key',
      'x-portkey-api-key': 'portkey-key',
    });
  });

  it('normalizes header names to lowercase and merges extraHeaders case-insensitively', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }],
      }),
    });

    const provider = new OpenAICompatEmbeddingProvider(
      {
        ...mockConfig,
        headers: {
          'X-Custom-Header': 'base-val',
          'Content-Type': 'application/json',
        },
      },
      {
        fetch: mockFetch,
        sleep: vi.fn(),
      },
    );

    await provider.embed(['test']);

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(callArgs[1].headers).toEqual({
      'x-custom-header': 'base-val',
      'content-type': 'application/json',
      'authorization': 'Bearer sk-test-key',
    });
  });

  it('does not overwrite custom Authorization header with apiKey in embed and healthCheck', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }],
      }),
    });

    const provider = new OpenAICompatEmbeddingProvider(
      {
        ...mockConfig,
        apiKey: 'sk-test-key',
        headers: {
          'Authorization': 'Bearer custom-token-123',
        },
      },
      {
        fetch: mockFetch,
        sleep: vi.fn(),
      },
    );

    await provider.embed(['test']);
    let callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer custom-token-123');

    mockFetch.mockClear();
    await provider.healthCheck();
    callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const healthHeaders = callArgs[1].headers as Record<string, string>;
    expect(healthHeaders['authorization']).toBe('Bearer custom-token-123');
  });

  it('throws EmbedError immediately if dimensions are not positive', async () => {
    const provider = new OpenAICompatEmbeddingProvider({ ...mockConfig, dimensions: 0 });
    await expect(provider.embed(['text1'])).rejects.toThrow('Embedding dimensions must be a positive integer');
  });

  it('retries on failure and succeeds', async () => {
    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) {
        return { ok: false, status: 500, text: async () => 'Internal Server Error' };
      }
      return {
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.5, 0.6] }],
        }),
      };
    });

    const mockSleep = vi.fn();

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: mockSleep,
    });

    const result = await provider.embed(['text1']);

    expect(result).toEqual([[0.5, 0.6]]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it('throws RetryExhaustedError when all retries fail', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const retryCount = mockConfig.retryCount;
    await expect(provider.embed(['text1'])).rejects.toThrow(RetryExhaustedError);
    // retryCount=3 means 1 initial try + 3 retries = 4 total attempts
    expect(mockFetch).toHaveBeenCalledTimes(retryCount + 1);
  });

  it('throws EmbedError immediately on 401 Unauthorized', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const promise = provider.embed(['text1']);
    await expect(promise).rejects.toThrow(EmbedError);
    await expect(promise).rejects.toThrow(/401/);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
  });

  it('throws DimensionMismatchError immediately if returned dimensions do not match', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3] }], // 3 dimensions instead of 2
      }),
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const promise = provider.embed(['text1']);
    await expect(promise).rejects.toThrow(DimensionMismatchError);
    await expect(promise).rejects.toThrow(/Unexpected embedding dimension/);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
  });

  it('falls back to requesting embeddings per item if returned count does not match input count', async () => {
    const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body as string);
      if (body.input.length > 1) {
        // Simulates an unbatched OpenAI-compatible API returning only 1 embedding when batched
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
        };
      }
      // Single item requests return their respective vector
      const vector = body.input[0] === 'text1' ? [0.1, 0.2] : [0.3, 0.4];
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: vector }] }),
      };
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const result = await provider.embed(['text1', 'text2']);
    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 initial batched call + 2 fallback calls
  });

  it('throws EmbedError immediately if returned embedding count does not match single input count', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [], // 0 embeddings for 1 input
      }),
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const promise = provider.embed(['text1']);
    await expect(promise).rejects.toThrow(EmbedError);
    await expect(promise).rejects.toThrow(/returned 0 embeddings for 1 inputs/);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
  });

  it('returns true from healthCheck when API is reachable', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const isHealthy = await provider.healthCheck();
    expect(isHealthy).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
      headers: { authorization: 'Bearer sk-test-key' }
    }));
  });

  it('returns false from healthCheck when API is unreachable', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const isHealthy = await provider.healthCheck();
    expect(isHealthy).toBe(false);
  });

  it('healthCheck preserves baseUrl path without hitting the embeddings endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const provider = new OpenAICompatEmbeddingProvider(
      { ...mockConfig, baseUrl: 'https://xxx.com/v1/embeddings' },
      { fetch: mockFetch, sleep: vi.fn() },
    );

    const isHealthy = await provider.healthCheck();
    expect(isHealthy).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('https://xxx.com/v1/embeddings/v1/models', expect.objectContaining({
      method: 'GET',
      headers: { authorization: 'Bearer sk-test-key' },
    }));
  });

  it('healthCheck preserves baseUrl path for TrueFoundry-style endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const provider = new OpenAICompatEmbeddingProvider(
      { ...mockConfig, baseUrl: 'https://gateway.truefoundry.ai/embeddings' },
      { fetch: mockFetch, sleep: vi.fn() },
    );

    const isHealthy = await provider.healthCheck();
    expect(isHealthy).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('https://gateway.truefoundry.ai/embeddings/v1/models', expect.objectContaining({
      method: 'GET',
      headers: { authorization: 'Bearer sk-test-key' },
    }));
  });

  it('healthCheck appends v1/models when baseUrl has no pathname', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const provider = new OpenAICompatEmbeddingProvider(
      { ...mockConfig, baseUrl: 'https://api.openai.com' },
      { fetch: mockFetch, sleep: vi.fn() },
    );

    const isHealthy = await provider.healthCheck();
    expect(isHealthy).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
      method: 'GET',
      headers: { authorization: 'Bearer sk-test-key' },
    }));
  });

  it('governs fallback requests with request-level concurrency limiter', async () => {
    let concurrentRequests = 0;
    let maxConcurrentObserved = 0;

    const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body as string);

      concurrentRequests++;
      maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrentRequests);

      // Simulate async work so concurrentRequests can stack if ungoverned
      await new Promise((resolve) => setTimeout(resolve, 10));

      if (body.input.length > 1) {
        concurrentRequests--;
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
        };
      }

      concurrentRequests--;
      const vector = body.input[0] === 'text1' ? [0.1, 0.2] : [0.3, 0.4];
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: vector }] }),
      };
    });

    const provider = new OpenAICompatEmbeddingProvider(
      { ...mockConfig, maxConcurrency: 1, batchSize: 2 },
      { fetch: mockFetch, sleep: vi.fn() },
    );

    const result = await provider.embed(['text1', 'text2']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(maxConcurrentObserved).toBe(1);
  });

  it('limits request concurrency during concurrent batch execution', async () => {
    let concurrentRequests = 0;
    let maxConcurrentObserved = 0;

    const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
      concurrentRequests++;
      maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrentRequests);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrentRequests--;

      const body = JSON.parse(options.body as string);
      return {
        ok: true,
        json: async () => ({
          data: body.input.map(() => ({ embedding: [0.1, 0.2] })),
        }),
      };
    });

    const provider = new OpenAICompatEmbeddingProvider(
      { ...mockConfig, maxConcurrency: 1, batchSize: 1 },
      { fetch: mockFetch, sleep: vi.fn() },
    );

    await provider.embed(['text1', 'text2', 'text3']);

    expect(maxConcurrentObserved).toBe(1);
  });

  it('shares maxConcurrency between batch requests and individual fallback requests', async () => {
    let concurrentRequests = 0;
    let maxConcurrentObserved = 0;

    const mockFetch = vi.fn().mockImplementation(async (_url, options) => {
      concurrentRequests++;
      maxConcurrentObserved = Math.max(maxConcurrentObserved, concurrentRequests);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const body = JSON.parse(options.body as string);
      if (body.input.length > 1) {
        concurrentRequests--;
        return {
          ok: true,
          json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
        };
      }

      concurrentRequests--;
      const vector = body.input[0] === 'text1' || body.input[0] === 'text3' ? [0.1, 0.2] : [0.3, 0.4];
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: vector }] }),
      };
    });

    const provider = new OpenAICompatEmbeddingProvider(
      { ...mockConfig, maxConcurrency: 2, batchSize: 2 },
      { fetch: mockFetch, sleep: vi.fn() },
    );

    const result = await provider.embed(['text1', 'text2', 'text3', 'text4']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(maxConcurrentObserved).toBeLessThanOrEqual(2);
  });
});
