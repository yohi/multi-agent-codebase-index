import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ToolName } from '../tools/registry/definitions.js';
import type { NexusToolCallResult, ToolHandler } from '../tools/types.js';

export interface V1RuntimeToolBridge {
  readonly handlers: Record<ToolName, ToolHandler>;
  close(): Promise<void>;
}

type TextContent = { readonly type: 'text'; readonly text: string };

type V1ToolResult = {
  readonly content: readonly unknown[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
};

const toolNames: readonly ToolName[] = [
  'semantic_search',
  'grep_search',
  'hybrid_search',
  'get_context',
  'index_status',
  'reindex',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isTextContent = (value: unknown): value is TextContent =>
  isRecord(value) && value['type'] === 'text' && typeof value['text'] === 'string';

const isV1ToolResult = (value: unknown): value is V1ToolResult =>
  isRecord(value) && Array.isArray(value['content']);

export const createV1RuntimeToolBridge = async (server: McpServer): Promise<V1RuntimeToolBridge> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'nexus-v2-runtime-bridge', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const handlers = {} as Record<ToolName, ToolHandler>;
  for (const name of toolNames) {
    handlers[name] = async (args: unknown, extra): Promise<NexusToolCallResult> => {
      if (!isRecord(args)) {
        throw new Error(`tool arguments for ${name} must be an object`);
      }
      const result = await client.callTool({ name, arguments: args }, undefined, {
        signal: extra?.signal,
      });
      if (!isV1ToolResult(result)) {
        throw new Error(`v1 runtime returned an unsupported result for ${name}`);
      }
      const content = result.content.filter(isTextContent);
      if (content.length !== result.content.length) {
        throw new Error(`v1 runtime returned unsupported content for ${name}`);
      }
      return {
        content,
        ...(result.isError === true ? { isError: true } : {}),
        ...(isRecord(result.structuredContent)
          ? { structuredContent: result.structuredContent }
          : {}),
      };
    };
  }

  return {
    handlers,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};
