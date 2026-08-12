import type { ServerResponse } from 'node:http';

import { isAllowedHostHeader, isAllowedOriginHeader } from './net.js';

export type HeaderVerdict = { ok: true } | { ok: false; reason: string };

export const validateRequestHeaders = (
  host: string | undefined,
  origin: string | undefined,
): HeaderVerdict => {
  if (!isAllowedHostHeader(host)) {
    return { ok: false, reason: 'Host header does not identify a loopback interface' };
  }
  if (!isAllowedOriginHeader(origin)) {
    return { ok: false, reason: 'Origin header does not identify a loopback interface' };
  }
  return { ok: true };
};

export const applySecurityHeaders = (res: ServerResponse): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
};
