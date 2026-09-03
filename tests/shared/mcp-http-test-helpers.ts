import { createServer, type Server } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createStreamableHttpHandler } from '../../src/server/transport.js';

export interface McpHttpTestServer {
  readonly httpServer: Server;
  readonly baseUrl: string;
  readonly dispose: () => Promise<void>;
}

export const startMcpHttpTestServer = async (
  createMcpServer: () => McpServer,
): Promise<McpHttpTestServer> => {
  const handler = createStreamableHttpHandler({ createServer: createMcpServer });
  const httpServer = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
    httpServer.once('error', reject);
  });

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    await handler.dispose();
    throw new Error('failed to bind test server');
  }

  return {
    httpServer,
    baseUrl: `http://127.0.0.1:${address.port}/mcp`,
    dispose: async () => {
      await handler.dispose();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
};

export const connectMcpClient = async (baseUrl: string, name: string): Promise<Client> => {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
  return client;
};
