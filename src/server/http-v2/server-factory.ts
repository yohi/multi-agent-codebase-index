import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';

import { registerV2Tools, type V2ToolLimits } from '../tools/registry/adapters/v2-adapter.js';
import { buildToolHandlers } from '../tools/tool-support.js';
import type { ToolName } from '../tools/registry/definitions.js';
import type { ToolHandler } from '../tools/types.js';
import type { NexusServerOptions } from '../index.js';

export interface V2ServerFactoryDeps {
  readonly options?: NexusServerOptions;
  readonly handlers?: Record<ToolName, ToolHandler>;
  readonly awaitInitialize?: () => Promise<void>;
  readonly limits: V2ToolLimits;
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

const DEFAULT_SERVER_INFO = { name: 'nexus', version: '0.1.0' } as const;

const resolveHandlers = (deps: V2ServerFactoryDeps): Record<ToolName, ToolHandler> => {
  if (deps.handlers !== undefined) {
    return deps.handlers;
  }
  if (deps.options !== undefined) {
    return buildToolHandlers(deps.options, deps.awaitInitialize);
  }
  throw new Error('v2 MCP handler requires tool handlers or server options');
};

export const createV2McpHandler = (deps: V2ServerFactoryDeps): McpHttpHandler =>
  createMcpHandler(
    () => {
      const server = new McpServer(deps.serverInfo ?? DEFAULT_SERVER_INFO, {
        capabilities: { tools: { listChanged: true } },
        instructions: 'Nexus MCP server for local code search and indexing.',
      });
      registerV2Tools(server, resolveHandlers(deps), deps.limits);
      return server;
    },
    { legacy: 'reject' },
  );
