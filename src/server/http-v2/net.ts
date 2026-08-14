import { isLoopbackHost } from '../../config/index.js';

const extractHost = (hostHeader: string): string => {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount > 1) {
    return trimmed;
  }
  const colonIndex = trimmed.indexOf(':');
  return colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex);
};

export const isAllowedHostHeader = (hostHeader: string | undefined): boolean => {
  if (hostHeader === undefined) {
    return false;
  }
  return isLoopbackHost(extractHost(hostHeader));
};

export const isAllowedOriginHeader = (originHeader: string | undefined): boolean => {
  if (originHeader === undefined || originHeader.trim() === '') {
    return true;
  }
  try {
    return isLoopbackHost(new URL(originHeader).hostname);
  } catch {
    return false;
  }
};
