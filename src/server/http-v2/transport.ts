import { toNodeHandler } from '@modelcontextprotocol/node';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Web-standard MCP handler shape. Declared structurally so the
 * @modelcontextprotocol/server import stays confined to server-factory.ts
 * and v2-adapter.ts.
 */
export interface FetchLikeHandler {
  fetch(request: Request): Promise<Response>;
}

export const createMcpNodeHandler = (
  handler: FetchLikeHandler,
): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => toNodeHandler(handler);
