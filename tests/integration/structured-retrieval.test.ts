import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createNexusServer } from '../../src/server/index.js';
import { createStreamableHttpHandler } from '../../src/server/transport.js';
import { Chunker } from '../../src/indexer/chunker.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import { SearchOrchestrator } from '../../src/search/orchestrator.js';
import { SemanticSearch } from '../../src/search/semantic.js';
import { PathSanitizer } from '../../src/server/path-sanitizer.js';
import { TestEmbeddingProvider } from '../unit/plugins/embeddings/test-embedding-provider.js';
import { TestGrepEngine } from '../unit/search/test-grep-engine.js';
import { InMemoryMetadataStore } from '../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../unit/storage/in-memory-vector-store.js';
import { SymbolRetrievalService } from '../../src/structured/retrieval-service.js';
import { createMockMetricsHooks } from '../shared/test-helpers.js';
import { createGenerationId, createSymbolId } from '../../src/structured/identity.js';
import { sha256Hex, decodeUtf8 } from '../../src/structured/hash.js';
import type { StructuredSource } from '../../src/structured/contracts.js';
import type { CodeChunk } from '../../src/types/index.js';

const makeSource = (filePath: string, text: string): StructuredSource => {
  const bytes = Buffer.from(text, 'utf8');
  return { filePath, language: 'typescript', bytes, text: decodeUtf8(bytes) };
};

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
    projectRoot = path.join(
      os.tmpdir(),
      `nexus-structured-retrieval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });

    const metadataStore = new InMemoryMetadataStore();
    const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
    await metadataStore.initialize();
    await metadataStore.bootstrapStructuredSchema();
    await vectorStore.initialize();

    const embeddingProvider = new TestEmbeddingProvider();
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.registerLanguage(new TypeScriptLanguagePlugin());
    pluginRegistry.registerEmbeddingProvider('test', embeddingProvider);
    pluginRegistry.setActiveEmbeddingProvider('test');

    const semanticSearch = new SemanticSearch({ vectorStore, embeddingProvider });
    const grepEngine = new TestGrepEngine();
    const orchestrator = new SearchOrchestrator({
      semanticSearch,
      grepEngine,
      projectRoot,
    });
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(pluginRegistry),
      embeddingProvider,
      pluginRegistry,
    });
    const sanitizer = await PathSanitizer.create(projectRoot);
    mockMetricsHooks = createMockMetricsHooks();
    const symbolRetrievalService = new SymbolRetrievalService({ catalog: metadataStore, sanitizer });

    // Seed an indexed chunk with symbolId so semantic/hybrid results can reference it.
    const chunkText = 'export function authenticate() { return true; }';
    const chunk: CodeChunk = {
      id: 'src/auth.ts:1',
      filePath: 'src/auth.ts',
      content: chunkText,
      language: 'typescript',
      symbolName: 'authenticate',
      symbolKind: 'function',
      startLine: 1,
      endLine: 1,
      hash: 'hash-auth',
    };
    await vectorStore.upsertChunks([chunk], await embeddingProvider.embed([chunk.content]));
    grepEngine.addFile('src/auth.ts', chunkText);

    await writeFile(path.join(projectRoot, 'src/auth.ts'), chunkText);

    // Stage a structured record so get_file_outline / get_symbol_source / get_symbol_context work.
    const source = makeSource('src/auth.ts', chunkText);
    const contentHash = sha256Hex(source.bytes);
    const generationId = createGenerationId({
      schemaVersion: 1,
      parserId: 'typescript',
      parserVersion: '1.0.0',
      contentHash,
    });
    const symbolId = createSymbolId({
      filePath: 'src/auth.ts',
      qualifiedName: 'authenticate',
      kind: 'function',
      signatureDiscriminator: '()',
      occurrence: 0,
    });

    const coordinator = new (await import('../../src/indexer/structured-index-coordinator.js')).StructuredIndexCoordinator({
      metadataStore,
      vectorStore,
      chunker: new Chunker(pluginRegistry),
      projectWriteCoordinator: new (await import('../../src/indexer/project-write-coordinator.js')).ProjectWriteCoordinator(),
    });

    await coordinator.stageFile({
      source,
      generationId,
      contentHash,
      fileCompleteness: 'complete',
      declarations: [
        {
          name: 'authenticate',
          symbolId,
          qualifiedName: 'authenticate',
          kind: 'function',
          signatureDiscriminator: '()',
          position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: chunkText.length },
          startByte: 0,
          endByte: source.bytes.length,
          sourceHash: contentHash,
          languageId: 'typescript',
          isExact: true,
        },
      ],
      imports: [],
      parserId: 'typescript',
      parserVersion: '1.0.0',
    });
    await coordinator.activateFile({ filePath: 'src/auth.ts', generationId });

    const createTestServer = () =>
      createNexusServer({
        projectRoot,
        sanitizer,
        semanticSearch,
        grepEngine,
        orchestrator,
        vectorStore,
        metadataStore,
        pipeline,
        pluginRegistry,
        runReindex: async () => [],
        loadFileContent: async (filePath) => {
          if (filePath === 'src/auth.ts' || path.relative(projectRoot, filePath) === 'src/auth.ts') {
            return chunkText;
          }
          throw new Error(`unexpected file: ${filePath}`);
        },
        metricsHooks: mockMetricsHooks,
        symbolRetrievalService,
      });
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
