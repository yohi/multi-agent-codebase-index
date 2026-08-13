import path from 'node:path';

import { Chunker } from '../../src/indexer/chunker.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { SearchOrchestrator } from '../../src/search/orchestrator.js';
import { SemanticSearch } from '../../src/search/semantic.js';
import { PathSanitizer } from '../../src/server/path-sanitizer.js';
import type { NexusServerOptions } from '../../src/server/tools/types.js';
import type { CodeChunk } from '../../src/types/index.js';
import { TestEmbeddingProvider } from '../unit/plugins/embeddings/test-embedding-provider.js';
import { TestGrepEngine } from '../unit/search/test-grep-engine.js';
import { InMemoryMetadataStore } from '../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../unit/storage/in-memory-vector-store.js';

export interface TestNexusContext {
  options: NexusServerOptions;
  metadataStore: InMemoryMetadataStore;
  vectorStore: InMemoryVectorStore;
  grepEngine: TestGrepEngine;
}

export const createTestNexusOptions = async (): Promise<TestNexusContext> => {
  const projectRoot = process.cwd();
  const metadataStore = new InMemoryMetadataStore();
  const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
  await metadataStore.initialize();
  await vectorStore.initialize();

  const embeddingProvider = new TestEmbeddingProvider();
  const pluginRegistry = new PluginRegistry();
  pluginRegistry.registerLanguage(new TypeScriptLanguagePlugin());
  pluginRegistry.registerEmbeddingProvider('test', embeddingProvider);
  pluginRegistry.setActiveEmbeddingProvider('test');

  const semanticSearch = new SemanticSearch({ vectorStore, embeddingProvider });
  const grepEngine = new TestGrepEngine();
  grepEngine.addFile('src/auth.ts', 'export function authenticate() {}\n');

  const chunk: CodeChunk = {
    id: 'src/auth.ts:1',
    filePath: 'src/auth.ts',
    content: 'export function authenticate() {}',
    language: 'typescript',
    symbolName: 'authenticate',
    symbolKind: 'function',
    startLine: 1,
    endLine: 1,
    hash: 'hash-1',
  };
  await vectorStore.upsertChunks([chunk], await embeddingProvider.embed([chunk.content]));

  const orchestrator = new SearchOrchestrator({ semanticSearch, grepEngine, projectRoot });
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker: new Chunker(pluginRegistry),
    embeddingProvider,
    pluginRegistry,
  });
  const sanitizer = await PathSanitizer.create(projectRoot);

  const options: NexusServerOptions = {
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
    loadFileContent: async (filePath: string) => {
      const relativePath = path.relative(projectRoot, filePath);
      if (relativePath === 'src/auth.ts' || filePath === 'src/auth.ts') {
        return 'export function authenticate() {}\n';
      }
      throw new Error(`unexpected file: ${filePath}`);
    },
  };

  return { options, metadataStore, vectorStore, grepEngine };
};
