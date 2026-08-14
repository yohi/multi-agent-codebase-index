import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createV1RuntimeToolBridge, type V1RuntimeToolBridge } from '../../../../src/server/http-v2/v1-runtime-bridge.js';

describe('createV1RuntimeToolBridge', () => {
  let bridge: V1RuntimeToolBridge | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it('forwards a parameterless handler call when arguments are undefined', async () => {
    const runtimeServer = new McpServer({ name: 'v1-runtime', version: '1.0.0' });
    runtimeServer.registerTool('index_status', {}, async () => ({
      content: [{ type: 'text', text: '{"status":"ok"}' }],
      structuredContent: { status: 'ok' },
    }));

    bridge = await createV1RuntimeToolBridge(runtimeServer);
    const result = await bridge.handlers.index_status(undefined);

    expect(result.structuredContent).toEqual({ status: 'ok' });
  });

  it('forwards the handler AbortSignal to the v1 runtime client call', async () => {
    const runtimeServer = new McpServer({ name: 'v1-runtime', version: '1.0.0' });
    let handlerCalled = false;
    runtimeServer.registerTool('index_status', {}, async () => {
      handlerCalled = true;
      return { content: [{ type: 'text', text: '{"status":"ok"}' }] };
    });

    bridge = await createV1RuntimeToolBridge(runtimeServer);
    const controller = new AbortController();
    controller.abort();

    await expect(bridge.handlers.index_status({}, { signal: controller.signal })).rejects.toThrow();
    expect(handlerCalled).toBe(false);
  });

  it('closes the runtime server when the client close fails', async () => {
    const runtimeServer = new McpServer({ name: 'v1-runtime', version: '1.0.0' });
    const serverClose = vi.spyOn(runtimeServer, 'close');
    const clientCloseError = new Error('client close failed');
    vi.spyOn(Client.prototype, 'close').mockRejectedValueOnce(clientCloseError);

    bridge = await createV1RuntimeToolBridge(runtimeServer);

    await expect(bridge.close()).rejects.toThrow(clientCloseError);
    expect(serverClose).toHaveBeenCalledOnce();
  });
});
