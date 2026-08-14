import { createServer, type Server } from 'node:http';

import { createRequestListener } from './routes.js';
import { createMcpNodeHandler, type FetchLikeHandler } from './transport.js';

export interface HttpV2ServerHandle {
  readonly server: Server;
  port(): number;
  close(): Promise<void>;
}

export interface HttpV2ServerDeps {
  readonly handler: FetchLikeHandler;
  readonly isReady: () => boolean;
  readonly host: string;
  readonly port: number;
}

export const startHttpV2Server = async (deps: HttpV2ServerDeps): Promise<HttpV2ServerHandle> => {
  const nodeHandler = createMcpNodeHandler(deps.handler);
  const server = createServer(createRequestListener({ mcpHandler: nodeHandler, isReady: deps.isReady }));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, deps.host, resolve);
  });

  return {
    server,
    port: () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('HTTP v2 server is not listening');
      }
      return address.port;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
};
