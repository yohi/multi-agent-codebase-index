import type { IncomingMessage, ServerResponse } from 'node:http';

import { applySecurityHeaders, validateMcpAcceptHeader, validateRequestHeaders } from './headers.js';

export type RouteName = 'health' | 'ready' | 'mcp' | null;

export const routeRequest = (method: string | undefined, pathname: string): RouteName => {
  if (method === 'GET' && pathname === '/health') return 'health';
  if (method === 'GET' && pathname === '/ready') return 'ready';
  if (method === 'POST' && pathname === '/mcp') return 'mcp';
  return null;
};

export const readyResponse = (ready: boolean): { readonly status: number; readonly body: Record<string, string> } =>
  ready
    ? { status: 200, body: { status: 'ready' } }
    : { status: 503, body: { status: 'not_ready', reason: 'NEXUS_STORAGE_UNAVAILABLE' } };

export interface RoutesDeps {
  readonly mcpHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly isReady: () => boolean;
}

const sendJson = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export const createRequestListener = (deps: RoutesDeps) =>
  (req: IncomingMessage, res: ServerResponse): void => {
    applySecurityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    switch (routeRequest(req.method, url.pathname)) {
      case 'health':
        sendJson(res, 200, { status: 'ok' });
        return;
      case 'ready': {
        const { status, body } = readyResponse(deps.isReady());
        sendJson(res, status, body);
        return;
      }
      case 'mcp': {
        const origin = req.headers.origin;
        const verdict = validateRequestHeaders(
          req.headers.host,
          typeof origin === 'string' ? origin : undefined,
        );
        if (!verdict.ok) {
          sendJson(res, 403, { error: verdict.reason });
          return;
        }
        const accept = req.headers.accept;
        const acceptVerdict = validateMcpAcceptHeader(typeof accept === 'string' ? accept : undefined);
        if (!acceptVerdict.ok) {
          sendJson(res, 406, { error: acceptVerdict.reason });
          return;
        }
        void deps.mcpHandler(req, res);
        return;
      }
      default:
        sendJson(res, 404, { error: 'Not found' });
    }
  };
