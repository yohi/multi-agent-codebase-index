import { createServer, get, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { isAllowedHostHeader, isAllowedOriginHeader } from '../../../../src/server/http-v2/net.js';
import { applySecurityHeaders, validateRequestHeaders } from '../../../../src/server/http-v2/headers.js';

const listen = async (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind to a TCP port'));
        return;
      }
      resolve((address as AddressInfo).port);
    });
  });

const requestHeaders = async (port: number): Promise<IncomingHttpHeaders> =>
  new Promise((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.headers));
    });
    request.once('error', reject);
  });

const close = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

describe('isAllowedHostHeader', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.0.1:9200', true],
    ['localhost', true],
    ['localhost:9200', true],
    ['[::1]:9200', true],
    ['127.0.1.5:1', true],
    ['0.0.0.0', false],
    ['0.0.0.0:9200', false],
    ['example.com', false],
    ['169.254.169.254', false],
    ['[::]:9200', false],
    [undefined, false],
  ])('accepts %p: %p', (host, expected) => {
    expect(isAllowedHostHeader(host)).toBe(expected);
  });
});

describe('isAllowedOriginHeader', () => {
  it.each([
    [undefined, true],
    ['http://127.0.0.1:9200', true],
    ['http://localhost:3000', true],
    ['http://[::1]:9200', true],
    ['https://evil.example', false],
    ['http://0.0.0.0:9200', false],
    ['not a url', false],
  ])('accepts %p: %p', (origin, expected) => {
    expect(isAllowedOriginHeader(origin)).toBe(expected);
  });
});

describe('validateRequestHeaders', () => {
  it('accepts a loopback host with a loopback origin', () => {
    expect(validateRequestHeaders('127.0.0.1:9200', 'http://127.0.0.1:9200')).toEqual({ ok: true });
  });

  it('rejects a non-loopback host', () => {
    expect(validateRequestHeaders('example.com', undefined).ok).toBe(false);
  });

  it('rejects a non-loopback origin', () => {
    expect(validateRequestHeaders('127.0.0.1:9200', 'https://evil.example').ok).toBe(false);
  });
});

describe('applySecurityHeaders', () => {
  it('adds no-sniff and no-store headers to responses', async () => {
    const server = createServer((_request, response) => {
      applySecurityHeaders(response);
      response.end();
    });
    try {
      const headers = await requestHeaders(await listen(server));
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['cache-control']).toBe('no-store');
    } finally {
      await close(server);
    }
  });
});
