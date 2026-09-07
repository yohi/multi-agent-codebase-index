import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RetryExhaustedError } from '../../../../src/types/index.js';
import {
  OllamaEmbeddingProvider,
  resolveLocalOllamaBaseUrl,
} from '../../../../src/plugins/embeddings/ollama.js';
import { TestEmbeddingProvider } from './test-embedding-provider.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const mockedLookup = lookup as unknown as {
  mockResolvedValueOnce(value: LookupAddress[]): void;
};

const { acquireGlobalLockMock } = vi.hoisted(() => ({
  acquireGlobalLockMock: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock('../../../../src/utils/global-lock.js', () => ({
  acquireGlobalLock: acquireGlobalLockMock,
}));
describe('OllamaEmbeddingProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
    acquireGlobalLockMock.mockClear();
  });

  it('pins a local Ollama hostname to its validated loopback address', async () => {
    mockedLookup.mockResolvedValueOnce([{ address: '127.0.0.2', family: 4 }]);

    await expect(resolveLocalOllamaBaseUrl('http://localhost:11434')).resolves.toBe(
      'http://127.0.0.2:11434/',
    );
  });

  it('waits for the global lock and passes the cancellation signal', async () => {
    let releaseLock: (() => void) | undefined;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    acquireGlobalLockMock.mockImplementationOnce(
      (_name: string, options: {
        signal?: AbortSignal;
        onRetry?: (retryCount: number, timeoutMs: number) => void;
      }) =>
        new Promise((resolve, reject) => {
          options.onRetry?.(1, 5_000);
          options.onRetry?.(2, 5_000);
          options.onRetry?.(6, 5_000);
          releaseLock = () => resolve({ release: vi.fn().mockResolvedValue(undefined) });
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        }),
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
    });
    const controller = new AbortController();
    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 0,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const pending = provider.embed(['alpha'], controller.signal);
    await vi.waitFor(() => expect(acquireGlobalLockMock).toHaveBeenCalledOnce());
    expect(acquireGlobalLockMock.mock.calls[0]?.[1]).toMatchObject({
      retryMode: 'unlimited',
      maxTimeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(acquireGlobalLockMock.mock.calls[0]?.[1]).toHaveProperty('onRetry', expect.any(Function));

    try {
      releaseLock?.();
      await pending;
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenNthCalledWith(
        1,
        '[Nexus] Waiting for Ollama global lock (retry 1; next retry in 5000ms)',
      );
      expect(warnSpy).toHaveBeenNthCalledWith(
        2,
        '[Nexus] Waiting for Ollama global lock (retry 6; next retry in 5000ms)',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('releases the lock before propagating cancellation detected after acquisition', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    acquireGlobalLockMock.mockResolvedValueOnce({ release });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
    });
    const controller = new AbortController();
    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 0,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const pending = provider.embed(['alpha'], controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases the lock if cancelled after acquisition before any batch starts', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    acquireGlobalLockMock.mockResolvedValueOnce({ release });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
    });
    const controller = new AbortController();
    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 0,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    queueMicrotask(() => controller.abort());

    await expect(provider.embed(['alpha'], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates cancellation to an in-flight Ollama request', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    acquireGlobalLockMock.mockResolvedValueOnce({ release });
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(
      (_url: unknown, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        }),
    );
    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 0,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const pending = provider.embed(['alpha'], controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('returns vectors with the configured dimensions for batched embedding', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3, 4], [4, 3, 2, 1]] }),
    });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 2,
        batchSize: 2,
        retryCount: 3,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const vectors = await provider.embed(['alpha', 'beta']);

    expect(vectors).toEqual([
      [1, 2, 3, 4],
      [4, 3, 2, 1],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries failed requests and throws RetryExhaustedError after max attempts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 3,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    await expect(provider.embed(['alpha'])).rejects.toBeInstanceOf(RetryExhaustedError);
    // retryCount=3 means 1 initial try + 3 retries = 4 total attempts
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('healthCheck does not consume the concurrency semaphore', async () => {
    let release: (() => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                ok: true,
                json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
              });
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
      });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 1,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const pendingEmbed = provider.embed(['alpha']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const healthy = await provider.healthCheck();
    release?.();
    await pendingEmbed;

    expect(healthy).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('blocks embed requests above maxConcurrency until a slot is released', async () => {
    const order: string[] = [];
    let firstRelease: (() => void) | undefined;

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            order.push('first-start');
            firstRelease = () => {
              order.push('first-end');
              resolve({
                ok: true,
                json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
              });
            };
          }),
      )
      .mockImplementationOnce(async () => {
        order.push('second-start');
        return {
          ok: true,
          json: async () => ({ embeddings: [[4, 3, 2, 1]] }),
        };
      });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 1,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const first = provider.embed(['alpha']);
    const second = provider.embed(['beta']);
    await vi.waitFor(() => expect(order).toEqual(['first-start']));

    firstRelease?.();

    await Promise.all([first, second]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('aborts hanging fetch after timeoutMs elapses and throws RetryExhaustedError', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockImplementation(
      (_url: unknown, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
          }
          options.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 0,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
        timeoutMs: 5_000,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const pending = provider.embed(['alpha']);
    
    // Use a Promise to catch the rejection as soon as it happens
    const catchPromise = expect(pending).rejects.toThrow(RetryExhaustedError);

    // Trigger the timeout
    await vi.runAllTimersAsync();

    await catchPromise;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('does NOT retry HTTP 400 "context length" errors and throws RetryExhaustedError immediately', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'the input length exceeds the context length',
    });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 3,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    await expect(provider.embed(['alpha'])).rejects.toBeInstanceOf(RetryExhaustedError);
    // 400 context-length errors must NOT be retried – exactly 1 attempt
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends truncate:true in the embed request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
    });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 0,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    await provider.embed(['hello']);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    expect(body['truncate']).toBe(true);
  });
  it.each([1, 2])('sends Ollama num_thread=%i in the embed request body', async (numThread) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
    });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 0,
        retryBaseDelayMs: 1,
        ollamaNumThread: numThread,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    await provider.embed(['hello']);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      options?: { num_thread?: number };
    };
    expect(body.options).toEqual({ num_thread: numThread });
  });
});

describe('TestEmbeddingProvider', () => {
  it('returns deterministic 64-dimensional vectors for the same text', async () => {
    const provider = new TestEmbeddingProvider();

    const first = await provider.embed(['same text']);
    const second = await provider.embed(['same text']);

    expect(first).toEqual(second);
    expect(first[0]).toHaveLength(64);
  });
});
