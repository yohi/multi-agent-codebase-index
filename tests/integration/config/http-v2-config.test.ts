import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

import { loadConfig } from '../../../src/config/index.js';

let projectRoot: string | undefined;

const mockedLookup = lookup as unknown as {
  mockImplementation(implementation: (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>): void;
  mockResolvedValue(value: LookupAddress[]): void;
  mockResolvedValueOnce(value: LookupAddress[]): void;
};

beforeEach(() => {
  mockedLookup.mockImplementation(async (hostname) => [
    { address: hostname === 'localhost' ? '127.0.0.1' : '203.0.113.1', family: 4 },
  ]);
});

afterEach(async () => {
  if (projectRoot !== undefined) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

const freshProjectRoot = async (): Promise<string> => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'nexus-http-config-'));
  return projectRoot;
};

describe('loadConfig transportMode="v2-http"', () => {
  it('exposes http defaults only in v2-http mode', async () => {
    const root = await freshProjectRoot();
    const stdioConfig = await loadConfig({ projectRoot: root, env: {} });
    expect(stdioConfig.http).toBeUndefined();

    const serveConfig = await loadConfig({
      projectRoot: root,
      env: {},
      transportMode: 'v2-http',
    });
    expect(serveConfig.http).toEqual({
      host: '127.0.0.1',
      maxTopK: 100,
      maxResultsLimit: 1000,
    });
  });

  it('prioritizes env over .nexus.json over defaults', async () => {
    const root = await freshProjectRoot();
    await writeFile(
      path.join(root, '.nexus.json'),
      JSON.stringify({ http: { host: 'localhost', port: 9201, maxTopK: 50 } }),
    );

    const fileOnly = await loadConfig({ projectRoot: root, env: {}, transportMode: 'v2-http' });
    expect(fileOnly.http).toEqual({ host: 'localhost', port: 9201, maxTopK: 50, maxResultsLimit: 1000 });

    const envOverride = await loadConfig({
      projectRoot: root,
      env: { NEXUS_HTTP_HOST: '127.0.0.1', NEXUS_HTTP_MAX_TOP_K: '25' },
      transportMode: 'v2-http',
    });
    expect(envOverride.http).toEqual({ host: '127.0.0.1', port: 9201, maxTopK: 25, maxResultsLimit: 1000 });
  });

  it('rejects a non-loopback host in v2-http mode', async () => {
    const root = await freshProjectRoot();
    await expect(
      loadConfig({
        projectRoot: root,
        env: { NEXUS_HTTP_HOST: '0.0.0.0' },
        transportMode: 'v2-http',
      }),
    ).rejects.toThrow(/loopback/);
  });

  it('rejects a loopback host with an out-of-range IPv4 octet', async () => {
    const root = await freshProjectRoot();
    await expect(
      loadConfig({
        projectRoot: root,
        env: { NEXUS_HTTP_HOST: '127.0.0.999' },
        transportMode: 'v2-http',
      }),
    ).rejects.toThrow(/loopback/);
  });

  it('rejects a hostname when any resolved address is not loopback', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '127.0.0.1', family: 4 },
      { address: '203.0.113.7', family: 4 },
    ]);

    const root = await freshProjectRoot();
    await expect(
      loadConfig({
        projectRoot: root,
        env: { NEXUS_HTTP_HOST: 'localhost' },
        transportMode: 'v2-http',
      }),
    ).rejects.toThrow(/loopback/);
  });

  it('rejects external embedding providers in v2-http mode', async () => {
    const root = await freshProjectRoot();
    for (const provider of ['openai-compat', 'bedrock'] as const) {
      await expect(
        loadConfig({
          projectRoot: root,
          env: { NEXUS_EMBEDDING_PROVIDER: provider },
          transportMode: 'v2-http',
        }),
      ).rejects.toThrow(/local-only/);
    }
  });

  it('rejects Ollama base URLs outside the loopback interface in v2-http mode', async () => {
    const root = await freshProjectRoot();
    for (const baseUrl of ['http://ollama.example:11434', 'https://127.0.0.1.evil.example:11434']) {
      await expect(
        loadConfig({
          projectRoot: root,
          env: {
            NEXUS_EMBEDDING_PROVIDER: 'ollama',
            NEXUS_EMBEDDING_BASE_URL: baseUrl,
          },
          transportMode: 'v2-http',
        }),
      ).rejects.toThrow(/Ollama.*loopback/);
    }
  });

  it('rejects an Ollama hostname when any resolved address is not loopback', async () => {
    mockedLookup.mockResolvedValueOnce([
      { address: '127.0.0.1', family: 4 },
      { address: '203.0.113.8', family: 4 },
    ]);

    const root = await freshProjectRoot();
    await expect(
      loadConfig({
        projectRoot: root,
        env: {
          NEXUS_EMBEDDING_PROVIDER: 'ollama',
          NEXUS_EMBEDDING_BASE_URL: 'http://localhost:11434',
        },
        transportMode: 'v2-http',
      }),
    ).rejects.toThrow(/Ollama.*loopback/);
  });

  it('does not expose Ollama base URL credentials in validation errors', async () => {
    const root = await freshProjectRoot();
    const baseUrl = 'https://user:password@evil.example:11434/embed?apiKey=secret';

    const error = await loadConfig({
      projectRoot: root,
      env: {
        NEXUS_EMBEDDING_PROVIDER: 'ollama',
        NEXUS_EMBEDDING_BASE_URL: baseUrl,
      },
      transportMode: 'v2-http',
    }).then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).toContain('evil.example');
    expect(error.message).not.toContain('user');
    expect(error.message).not.toContain('password');
    expect(error.message).not.toContain('apiKey');
    expect(error.message).not.toContain('secret');
  });

  it('uses a fixed error message for malformed Ollama base URLs', async () => {
    const root = await freshProjectRoot();
    const errors: string[] = [];

    for (const baseUrl of ['not a url', 'still not a url']) {
      const error = await loadConfig({
        projectRoot: root,
        env: {
          NEXUS_EMBEDDING_PROVIDER: 'ollama',
          NEXUS_EMBEDDING_BASE_URL: baseUrl,
        },
        transportMode: 'v2-http',
      }).then(() => undefined, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) errors.push(error.message);
    }

    expect(errors[0]).toBe(errors[1]);
  });

  it('rejects unsupported Ollama URL schemes', async () => {
    const root = await freshProjectRoot();

    for (const baseUrl of ['ftp://127.0.0.1:11434', 'file://127.0.0.1/tmp/ollama']) {
      await expect(
        loadConfig({
          projectRoot: root,
          env: {
            NEXUS_EMBEDDING_PROVIDER: 'ollama',
            NEXUS_EMBEDDING_BASE_URL: baseUrl,
          },
          transportMode: 'v2-http',
        }),
      ).rejects.toThrow(/Ollama.*loopback/);
    }
  });

  it('accepts an Ollama base URL on a loopback interface in v2-http mode', async () => {
    const root = await freshProjectRoot();
    await expect(
      loadConfig({
        projectRoot: root,
        env: {
          NEXUS_EMBEDDING_PROVIDER: 'ollama',
          NEXUS_EMBEDDING_BASE_URL: 'http://[::1]:11434',
        },
        transportMode: 'v2-http',
      }),
    ).resolves.toMatchObject({ embedding: { baseUrl: 'http://[::1]:11434' } });
  });

  it('accepts a valid HTTPS Ollama base URL on a loopback interface', async () => {
    const root = await freshProjectRoot();

    await expect(
      loadConfig({
        projectRoot: root,
        env: {
          NEXUS_EMBEDDING_PROVIDER: 'ollama',
          NEXUS_EMBEDDING_BASE_URL: 'https://localhost:11434',
        },
        transportMode: 'v2-http',
      }),
    ).resolves.toMatchObject({ embedding: { baseUrl: 'https://localhost:11434' } });
  });

  it('accepts the default Ollama base URL when it is not specified', async () => {
    const root = await freshProjectRoot();

    await expect(
      loadConfig({
        projectRoot: root,
        env: { NEXUS_EMBEDDING_PROVIDER: 'ollama' },
        transportMode: 'v2-http',
      }),
    ).resolves.toMatchObject({ embedding: { baseUrl: 'http://127.0.0.1:11434' } });
  });
});
