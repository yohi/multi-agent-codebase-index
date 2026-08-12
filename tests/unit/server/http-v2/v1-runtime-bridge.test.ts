import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createV1RuntimeToolBridge, type V1RuntimeToolBridge } from '../../../../src/server/http-v2/v1-runtime-bridge.js';

describe('createV1RuntimeToolBridge', () => {
  let bridge: V1RuntimeToolBridge | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it('forwards a v2 handler call through the initialized v1 runtime server', async () => {
    const runtimeServer = new McpServer({ name: 'v1-runtime', version: '1.0.0' });
    runtimeServer.registerTool('index_status', {}, async () => ({
      content: [{ type: 'text', text: '{"status":"ok"}' }],
      structuredContent: { status: 'ok' },
    }));

    bridge = await createV1RuntimeToolBridge(runtimeServer);
    const result = await bridge.handlers.index_status({});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ status: 'ok' });
    expect(result.content).toEqual([{ type: 'text', text: '{"status":"ok"}' }]);
  });
});
