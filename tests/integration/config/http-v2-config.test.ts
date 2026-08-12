import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/index.js';

let projectRoot: string | undefined;

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
});
