import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, toolResult } from './tools/tool-support.js';

import type { SearchOrchestrator } from "../search/orchestrator.js";
import type { ISemanticSearch } from "../search/semantic.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type {
  IMetadataStore,
  IVectorStore,
  IGrepEngine,
  IndexEvent,
  IFileWatcher,
  ReindexOptions,
  IIndexPipeline,
} from "../types/index.js";
import { type PathSanitizer } from "./path-sanitizer.js";
import { executeGetContext } from "./tools/get-context.js";
import { getContextInputSchema } from "./tools/get-context-schema.js";
import { executeGrepSearch, type GrepSearchToolArgs } from "./tools/grep-search.js";
import { executeHybridSearch, type HybridSearchToolArgs } from "./tools/hybrid-search.js";
import { executeIndexStatus } from "./tools/index-status.js";
import { executeReindex } from "./tools/reindex.js";
import { executeSemanticSearch, type SemanticSearchToolArgs } from "./tools/semantic-search.js";
import { MetricsHttpServer } from "../observability/metrics-server.js";
import type { Registry } from "prom-client";
import { writeMetricsPort, removeMetricsPort } from "./metrics-port.js";
import { withToolMetrics } from "./tool-instrumentation.js";
import type { MetricsHooks } from "../observability/types.js";
import { RegistrationClient } from "../observability/registration-client.js";

export { errorResult, toolResult } from './tools/tool-support.js';

export interface NexusServerOptions {
  projectRoot: string;
  sanitizer: PathSanitizer;
  semanticSearch: ISemanticSearch;
  grepEngine: IGrepEngine;
  orchestrator: SearchOrchestrator;
  vectorStore: IVectorStore;
  metadataStore: IMetadataStore;
  pipeline: IIndexPipeline;
  pluginRegistry: PluginRegistry;
  runReindex: (options?: ReindexOptions) => Promise<IndexEvent[]>;
  loadFileContent: (filePath: string) => Promise<string>;
  metricsHooks?: MetricsHooks;
  packageMode?: boolean;
}

export interface NexusRuntimeOptions extends NexusServerOptions {
  watcher: IFileWatcher;
  onClose?: () => Promise<void>;
  metricsCollectorRegistry?: Registry;
  metricsPort?: number;
  storageDir?: string;
  projectName?: string;
  aggregatorPort?: number;
}

export interface NexusRuntime {
  createServer(): McpServer;
  orchestrator: SearchOrchestrator;
  sanitizer: PathSanitizer;
  initialize(): Promise<void>;
  close(): Promise<void>;
  reindex(fullRebuild?: boolean): Promise<void>;
  registrationClient?: RegistrationClient | null;
}

function resolveProjectId(projectRoot: string, projectName?: string): string {
  return projectName ?? projectRoot.split(/[\\/]/).findLast(Boolean) ?? "unknown";
}

async function syncMetricsPortFile(storageDir: string | undefined, resolvedPort: number | undefined): Promise<void> {
  if (!storageDir) {
    return;
  }

  if (resolvedPort !== undefined) {
    await writeMetricsPort(storageDir, resolvedPort).catch((err) => {
      console.warn("[Nexus] Failed to write metrics port file:", err);
    });
    return;
  }

  await removeMetricsPort(storageDir).catch((err) => {
    console.warn("[Nexus] Failed to remove stale metrics port file:", err);
  });
}

function createRegistrationClient(
  aggregatorPort: number,
  resolvedPort: number | undefined,
  projectRoot: string,
  projectName?: string,
): RegistrationClient | null {
  if (resolvedPort === undefined) {
    return null;
  }

  const client = new RegistrationClient(
    {
      projectId: resolveProjectId(projectRoot, projectName),
      metricsPort: resolvedPort,
      pid: process.pid,
    },
    { aggregatorPort, heartbeatIntervalMs: 30000, requestTimeoutMs: 1000 },
  );
  client.start();
  return client;
}

export const createNexusServer = (
  options: NexusServerOptions,
  awaitInitialize?: () => Promise<void>,
): McpServer => {
  const server = new McpServer(
    {
      name: "nexus",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
      instructions: "Nexus MCP server for local code search and indexing.",
    },
  );

  server.registerTool(
    "semantic_search",
    {
      description: "Vector-only semantic search; prefer hybrid_search for most tasks.",
      inputSchema: {
        query: z.string(),
        topK: z.number().int().positive().optional(),
        filePattern: z.string().optional(),
        filePatterns: z.array(z.string()).optional(),
        language: z.string().optional(),
      },
    },
    withToolMetrics(
      "semantic_search",
      options.metricsHooks,
      async (args, extra) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeSemanticSearch(
            options.semanticSearch,
            options.sanitizer,
            args as SemanticSearchToolArgs & { filePattern?: string },
            extra?.signal,
          );
          options.metricsHooks?.onSearchResults('semantic', result.results.length);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  server.registerTool(
    "grep_search",
    {
      description: "Exact string search for symbols, errors, or code fragments.",
      inputSchema: {
        pattern: z.string(),
        filePattern: z.string().optional(),
        filePatterns: z.array(z.string()).optional(),
        caseSensitive: z.boolean().optional(),
        maxResults: z.number().int().positive().optional(),
      },
    },
    withToolMetrics(
      "grep_search",
      options.metricsHooks,
      async (args, extra) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeGrepSearch(
            options.grepEngine,
            options.projectRoot,
            options.sanitizer,
            args as GrepSearchToolArgs,
            extra?.signal,
          );
          options.metricsHooks?.onSearchResults('grep', result.matches.length);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  server.registerTool(
    "hybrid_search",
    {
      description: "Semantic + grep hybrid search for vague or conceptual queries.",
      inputSchema: {
        query: z.string(),
        topK: z.number().int().positive().optional(),
        filePattern: z.string().optional(),
        filePatterns: z.array(z.string()).optional(),
        language: z.string().optional(),
        grepPattern: z.string().optional(),
        includeSnippet: z.boolean().optional(),
        contextLines: z.number().int().positive().optional().describe(
          "Lines of context to include before and after each match when includeSnippet is true. Maximum 20; values above are clamped.",
        ),
      },
    },
    withToolMetrics(
      "hybrid_search",
      options.metricsHooks,
      async (args, extra) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeHybridSearch(
            options.orchestrator,
            options.sanitizer,
            options.loadFileContent,
            args as HybridSearchToolArgs & { filePattern?: string },
            extra?.signal,
            options.metricsHooks,
          );
          options.metricsHooks?.onSearchResults('hybrid', result.results.length);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  server.registerTool(
    "get_context",
    {
      description: "Return a specific line range from a file; prefer partial reads.",
      inputSchema: getContextInputSchema,
    },
    withToolMetrics(
      "get_context",
      options.metricsHooks,
      async (args) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          const result = await executeGetContext(
            options.loadFileContent,
            options.sanitizer,
            args,
          );
          const lineCount = 'mode' in result
            ? result.previewEndLine - result.previewStartLine + 1
            : result.endLine - result.startLine + 1;
          options.metricsHooks?.onContextLinesFetched('get_context', lineCount);
          return toolResult(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  server.registerTool(
    "index_status",
    {
      description: "Check indexing progress and statistics before searching.",
      inputSchema: {},
    },
    withToolMetrics(
      "index_status",
      options.metricsHooks,
      async () => {
        if (awaitInitialize) await awaitInitialize();
        try {
          return toolResult(
            await executeIndexStatus(
              options.metadataStore,
              options.vectorStore,
              options.pluginRegistry,
              options.pipeline,
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  server.registerTool(
    "reindex",
    {
      description: "Manually rebuild the local search index.",
      inputSchema: {
        fullRebuild: z.boolean().optional(),
      },
    },
    withToolMetrics(
      "reindex",
      options.metricsHooks,
      async (args) => {
        if (awaitInitialize) await awaitInitialize();
        try {
          return toolResult(
            await executeReindex(
              options.pipeline,
              options.runReindex,
              options.loadFileContent,
              args,
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    )
  );

  return server;
};

export const buildNexusRuntime = (
  options: NexusRuntimeOptions,
): NexusRuntime => {
  let metricsServer: MetricsHttpServer | null = null;
  let initPromise: Promise<void> | null = null;
  let registrationClient: RegistrationClient | null = null;

  const initialize = (): Promise<void> => {
    if (initPromise) {
      return initPromise;
    }
  initPromise = (async () => {
      await options.metadataStore.initialize();
      await options.vectorStore.initialize();
      await options.pipeline.reconcileOnStartup();

      try {
        options.pipeline.start();
        await options.watcher.start().catch((error) => {
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? (error as Record<string, unknown>).code
              : undefined;
          const isNonFatal = code === "EMFILE" || code === "ENOSPC";

          if (isNonFatal) {
            console.error(
              `[Nexus Server Warning] Failed to start FileWatcher (${code}):`,
              error,
            );
          } else {
            throw error;
          }
        });

        // Use port 0 for auto-assignment, unless explicitly overridden.
        const preferredPort = options.metricsPort ?? 0;
        metricsServer = options.metricsCollectorRegistry
          ? new MetricsHttpServer(options.metricsCollectorRegistry)
          : null;
        if (metricsServer) {
          await metricsServer.start(preferredPort).catch((err) => {
            console.warn("[Nexus] Failed to start metrics HTTP server:", err);
          });
          const resolvedPort = metricsServer.getPort();
          await syncMetricsPortFile(options.storageDir, resolvedPort);
          registrationClient = options.packageMode
            ? null
            : createRegistrationClient(
                options.aggregatorPort ?? 9470,
                resolvedPort,
                options.projectRoot,
                options.projectName,
              );
        }
      } catch (error) {
        await options.pipeline.stop().catch((stopError: unknown) => {
          console.error(
            "Failed to stop pipeline during initialization rollback:",
            stopError,
          );
        });
        await options.watcher.stop().catch((stopError: unknown) => {
          console.error(
            "Failed to stop watcher during initialization rollback:",
            stopError,
          );
        });
        throw error;
      }
    })().catch((err) => {
      // Reset initPromise on failure so initialize() can be retried later
      initPromise = null;
      throw err;
    });
    return initPromise;
  };
  const close = async () => {
    const shutdownErrors: unknown[] = [];

    // Wait for any ongoing initialization to complete or fail before
    // proceeding with shutdown. If initialization is in progress, calling
    // stop() while start() is running can leave watcher/pipeline in an
    // undefined state.
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // Initialization failed; rollback inside initialize() already
        // attempted cleanup. Proceed with the rest of shutdown.
      }
    }

    if (metricsServer) {
      try {
        await metricsServer.stop();
      } catch (error) {
        shutdownErrors.push(error);
      }
      if (options.storageDir) {
        await removeMetricsPort(options.storageDir).catch(() => {});
      }
    }
    if (registrationClient) {
      registrationClient.stop();
      registrationClient = null;
    }


    if (options.onClose) {
      try {
        await options.onClose();
      } catch (error) {
        shutdownErrors.push(error);
      }
    }

    try {
      await options.watcher.stop();
    } catch (error) {
      shutdownErrors.push(error);
    }

    try {
      await options.pipeline.stop();
    } catch (error) {
      shutdownErrors.push(error);
    }


    if (shutdownErrors.length === 1) {
      throw shutdownErrors[0];
    } else if (shutdownErrors.length > 1) {
      throw new AggregateError(
        shutdownErrors,
        "Multiple errors occurred during Nexus runtime shutdown",
      );
    }
  };

  const reindex = async (fullRebuild?: boolean) => {
    await initialize();
    const result = await options.pipeline.reindex(
      options.runReindex,
      options.loadFileContent,
      fullRebuild,
    );
    if ("status" in result) {
      throw new Error(`Reindex already running: ${result.status}`);
    }
  };

  const createServer = (): McpServer => createNexusServer(options, () => initialize());

  return {
    createServer,
    orchestrator: options.orchestrator,
    sanitizer: options.sanitizer,
    initialize,
    close,
    reindex,
    get registrationClient() { return registrationClient; }
  };
};

export const initializeNexusRuntime = async (
  options: NexusRuntimeOptions,
): Promise<NexusRuntime> => {
  const runtime = buildNexusRuntime(options);
  await runtime.initialize();
  return runtime;
};
