import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';

import { registerV2Tools, type V2ToolLimits } from '../tools/registry/adapters/v2-adapter.js';
import { buildToolHandlers } from '../tools/tool-support.js';
import type { NexusServerOptions } from '../tools/types.js';

export interface V2ServerFactoryDeps {
  readonly options: NexusServerOptions;
  readonly awaitInitialize: () => Promise<void>;
  readonly limits: V2ToolLimits;
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

const DEFAULT_SERVER_INFO = { name: 'nexus', version: '0.1.0' } as const;

export const createV2McpHandler = (deps: V2ServerFactoryDeps): McpHttpHandler =>
  createMcpHandler(
    () => {
      const server = new McpServer(deps.serverInfo ?? DEFAULT_SERVER_INFO, {
        capabilities: { tools: { listChanged: true } },
        instructions: 'Nexus MCP server for local code search and indexing.',
      });
      registerV2Tools(server, buildToolHandlers(deps.options, deps.awaitInitialize), deps.limits);
      return server;
    },
    { legacy: 'reject' },
  );
