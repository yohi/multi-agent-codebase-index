import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createNexusServer } from '../../src/server/index.js';
import { createStreamableHttpHandler } from '../../src/server/transport.js';
import { createMockMetricsHooks } from '../shared/test-helpers.js';
import { createTestNexusOptions } from '../shared/create-test-nexus-options.js';
import {
  createStructuredCoordinator,
  createStructuredStage,
  stageStructuredFile,
} from '../shared/structured-test-helpers.js';

const parseResult = (result: any) => {
  if (result.content?.[0]?.type === 'text') {
    return JSON.parse(result.content[0].text);
  }
  return result.structuredContent;
};

describe('Structured retrieval MCP integration', () => {
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;
  let client: Client | null = null;
  let projectRoot: string;
  let mockMetricsHooks: ReturnType<typeof createMockMetricsHooks>;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-structured-retrieval-'));
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });

    const chunkText = 'export function authenticate() { return true; }';
    mockMetricsHooks = createMockMetricsHooks();

    await writeFile(path.join(projectRoot, 'src/auth.ts'), chunkText);

    const context = await createTestNexusOptions({
      projectRoot,
      fileContent: chunkText,
      chunkContent: chunkText,
      bootstrapStructuredSchema: true,
      metricsHooks: mockMetricsHooks,
    });
    const { options, metadataStore, vectorStore } = context;
    const stage = createStructuredStage('src/auth.ts', chunkText, 'authenticate', {
      signatureDiscriminator: '()',
      endColumn: chunkText.length,
    });
    const coordinator = createStructuredCoordinator({
      metadataStore,
      vectorStore,
      pluginRegistry: options.pluginRegistry,
    });
    await stageStructuredFile(coordinator, stage);
    await coordinator.activateFile({ filePath: stage.source.filePath, generationId: stage.generationId });

    const createTestServer = () => createNexusServer(options);
    const handler = createStreamableHttpHandler({ createServer: createTestServer });

    httpServer = createServer((req, res) => {
      void handler(req, res);
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('failed to bind test server');
    }
    baseUrl = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('exposes structured retrieval tools in the tool catalog', async () => {
    client = new Client({ name: 'structured-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'get_context',
      'get_file_outline',
      'get_symbol_context',
      'get_symbol_source',
      'grep_search',
      'hybrid_search',
      'index_status',
      'reindex',
      'semantic_search',
    ]);
  });

  it('returns a file outline for a structured indexed file', async () => {
    client = new Client({ name: 'structured-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({
      name: 'get_file_outline',
      arguments: { filePath: 'src/auth.ts' },
    });
    const parsed = parseResult(result);
    expect(parsed).toMatchObject({
      status: 'ok',
    });
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'authenticate',
          symbolId: expect.any(String),
          kind: 'function',
        }),
      ]),
    );
    expect(mockMetricsHooks.onStructuredRetrievalOutcome).toHaveBeenCalledWith('get_file_outline', 'ok');
  });

  it('returns exact symbol source for a known symbol id', async () => {
    client = new Client({ name: 'structured-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const outline = parseResult(
      await client.callTool({ name: 'get_file_outline', arguments: { filePath: 'src/auth.ts' } }),
    );
    const symbolId = outline.symbols.find((d: any) => d.name === 'authenticate')?.symbolId;
    expect(symbolId).toBeDefined();

    const result = await client.callTool({
      name: 'get_symbol_source',
      arguments: { symbolId },
    });
    const parsed = parseResult(result);
    expect(parsed).toMatchObject({
      status: 'ok',
      freshness: 'fresh',
      source: 'export function authenticate() { return true; }',
    });
    expect(mockMetricsHooks.onStructuredRetrievalOutcome).toHaveBeenCalledWith('get_symbol_source', 'ok');
  });

  it('returns bounded symbol context with budget metadata', async () => {
    client = new Client({ name: 'structured-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const outline = parseResult(
      await client.callTool({ name: 'get_file_outline', arguments: { filePath: 'src/auth.ts' } }),
    );
    const symbolId = outline.symbols.find((d: any) => d.name === 'authenticate')?.symbolId;
    expect(symbolId).toBeDefined();

    const result = await client.callTool({
      name: 'get_symbol_context',
      arguments: { symbolId, tokenBudget: 500 },
    });
    const parsed = parseResult(result);
    expect(parsed).toMatchObject({
      status: 'ok',
      request: { symbolId, tokenBudget: 500 },
    });
    expect(parsed.budget).toMatchObject({
      requested: 500,
      actual: expect.any(Number),
      exceeded: false,
      omittedForBudget: 0,
    });
    expect(parsed.context).toEqual('export function authenticate() { return true; }');
    expect(mockMetricsHooks.onStructuredRetrievalOutcome).toHaveBeenCalledWith('get_symbol_context', 'ok');
    expect(mockMetricsHooks.onStructuredContextTokens).toHaveBeenCalled();
  });

  it('returns an error response when the file is not structured-indexed', async () => {
    client = new Client({ name: 'structured-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({
      name: 'get_file_outline',
      arguments: { filePath: 'src/not-indexed.ts' },
    });
    const parsed = parseResult(result);
    expect(parsed).toMatchObject({
      status: 'not_found',
      request: { filePath: 'src/not-indexed.ts' },
    });
    expect(mockMetricsHooks.onStructuredRetrievalOutcome).toHaveBeenCalledWith('get_file_outline', 'not_found');
  });

  it('reports structured index status in index_status', async () => {
    client = new Client({ name: 'structured-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = parseResult(await client.callTool({ name: 'index_status', arguments: {} }));
    expect(result.structuredIndex).toMatchObject({
      schemaVersion: 1,
      targetSchemaVersion: 1,
      status: 'idle',
      totalFiles: 1,
      totalSymbols: 1,
      exactFiles: 1,
      pendingFiles: 0,
      reindexRequired: false,
    });
  });
});
