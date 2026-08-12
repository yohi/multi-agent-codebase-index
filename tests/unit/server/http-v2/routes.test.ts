import { describe, expect, it } from 'vitest';

import { readyResponse, routeRequest } from '../../../../src/server/http-v2/routes.js';

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
