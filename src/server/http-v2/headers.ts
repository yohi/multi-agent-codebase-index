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

const isPositiveQualityValue = (value: string): boolean => {
  if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) {
    return false;
  }
  return Number(value) > 0;
};

const acceptsMediaType = (accept: string, mediaType: string): boolean =>
  accept.split(',').some((entry) => {
    const [rawType, ...rawParameters] = entry.split(';');
    if (rawType?.trim().toLowerCase() !== mediaType) {
      return false;
    }
    for (const parameter of rawParameters) {
      const [rawName, rawValue, ...extra] = parameter.split('=');
      if (rawName?.trim().toLowerCase() !== 'q') {
        continue;
      }
      if (extra.length > 0 || rawValue === undefined || !isPositiveQualityValue(rawValue.trim())) {
        return false;
      }
    }
    return true;
  });

export const validateMcpAcceptHeader = (accept: string | undefined): HeaderVerdict => {
  if (
    accept === undefined ||
    !acceptsMediaType(accept, 'application/json') ||
    !acceptsMediaType(accept, 'text/event-stream')
  ) {
    return {
      ok: false,
      reason: 'Accept header must allow application/json and text/event-stream',
    };
  }
  return { ok: true };
};

export const applySecurityHeaders = (res: ServerResponse): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
};
