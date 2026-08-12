import { createServer, request, type Server } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createRequestListener, readyResponse, routeRequest } from '../../../../src/server/http-v2/routes.js';

const listen = async (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });

const close = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const postWithoutAcceptHeader = async (port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const clientRequest = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    clientRequest.once('error', reject);
    clientRequest.end('{}');
  });

describe('routeRequest', () => {
  it.each([
    ['GET', '/health', 'health'],
    ['GET', '/ready', 'ready'],
    ['POST', '/mcp', 'mcp'],
    ['GET', '/mcp', null],
    ['DELETE', '/mcp', null],
    ['POST', '/other', null],
    ['GET', '/', null],
  ] as const)('%s %s routes to %s', (method, pathname, expected) => {
    expect(routeRequest(method, pathname)).toBe(expected);
  });
});

describe('readyResponse', () => {
  it('returns ready when storage is available', () => {
    expect(readyResponse(true)).toEqual({ status: 200, body: { status: 'ready' } });
  });

  it('returns NEXUS_STORAGE_UNAVAILABLE when storage is unavailable', () => {
    expect(readyResponse(false)).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'NEXUS_STORAGE_UNAVAILABLE' },
    });
  });
});

describe('createRequestListener', () => {
  it('rejects an unacceptable Accept header before dispatching to the MCP SDK handler', async () => {
    let mcpHandlerCalled = false;
    const server = createServer(
      createRequestListener({
        isReady: () => true,
        mcpHandler: async (_request, response) => {
          mcpHandlerCalled = true;
          response.end();
        },
      }),
    );
    try {
      const port = await listen(server);
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: '{}',
      });

      expect(response.status).toBe(406);
      expect(mcpHandlerCalled).toBe(false);
    } finally {
      await close(server);
    }
  });

  it('rejects a missing Accept header before dispatching to the MCP SDK handler', async () => {
    let mcpHandlerCalled = false;
    const server = createServer(
      createRequestListener({
        isReady: () => true,
        mcpHandler: async (_request, response) => {
          mcpHandlerCalled = true;
          response.end();
        },
      }),
    );
    try {
      const port = await listen(server);

      expect(await postWithoutAcceptHeader(port)).toBe(406);
      expect(mcpHandlerCalled).toBe(false);
    } finally {
      await close(server);
    }
  });
});
