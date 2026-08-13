import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { buildToolHandlers } from '../../../../../../src/server/tools/tool-support.js';
import { registerV1Tools } from '../../../../../../src/server/tools/registry/adapters/v1-adapter.js';
import { createTestNexusOptions } from '../../../../../shared/create-test-nexus-options.js';

const EXPECTED_TOOLS = [
  {
    name: 'semantic_search',
    description: 'Vector-only semantic search; prefer hybrid_search for most tasks.',
    required: ['query'],
  },
  {
    name: 'grep_search',
    description: 'Exact string search for symbols, errors, or code fragments.',
    required: ['pattern'],
  },
  {
    name: 'hybrid_search',
    description: 'Semantic + grep hybrid search for vague or conceptual queries.',
    required: ['query'],
  },
  {
    name: 'get_context',
    description: 'Return a specific line range from a file; prefer partial reads.',
    required: ['filePath'],
  },
  {
    name: 'index_status',
    description: 'Check indexing progress and statistics before searching.',
    required: [],
  },
  {
    name: 'reindex',
    description: 'Manually rebuild the local search index.',
    required: [],
  },
] as const;

describe('v1 adapter parity', () => {
  let client: Client | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
  });

  const connect = async (): Promise<Client> => {
    const { options } = await createTestNexusOptions();
    server = new McpServer(
      { name: 'nexus', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    registerV1Tools(server, buildToolHandlers(options));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'v1-parity-client', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };

  it('lists the 6 tools with legacy names, descriptions and required params', async () => {
    const connected = await connect();
    const listed = await connected.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS.map((tool) => tool.name));
    for (const expected of EXPECTED_TOOLS) {
      const actual = listed.tools.find((tool) => tool.name === expected.name);
      expect(actual?.description).toBe(expected.description);
      expect(actual?.inputSchema.required ?? []).toEqual(expected.required);
    }
  });

  it('calls grep_search and returns the legacy structuredContent shape', async () => {
    const connected = await connect();
    const result = await connected.callTool({ name: 'grep_search', arguments: { pattern: 'authenticate' } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      matches: [expect.objectContaining({ filePath: 'src/auth.ts' })],
    });
  });

  it('keeps the legacy error shape on the v1 path', async () => {
    const connected = await connect();
    const result = await connected.callTool({ name: 'get_context', arguments: { filePath: 'nope.ts' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: true });
    expect(result.structuredContent).not.toHaveProperty('code');
  });
});
