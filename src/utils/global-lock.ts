import { createHash } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import lockfile from 'proper-lockfile';

export const GLOBAL_LOCK_STALE_MS = 60_000;
export const GLOBAL_LOCK_RETRIES = 10;
export const GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS = 100;
export const GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS = 1000;

/**
 * Derives a startup lock name based on the canonical path of the storage directory.
 * Note that the storage directory must already exist; otherwise, `realpath` will throw an ENOENT error.
 *
 * @param storageDir The path to the storage directory.
 */
export const projectStartupLockName = async (storageDir: string): Promise<string> => {
  const canonicalStorageDir = await realpath(storageDir);
  return `project-start-${createHash('sha256').update(canonicalStorageDir).digest('hex')}`;
};

const GLOBAL_LOCK_ERROR_MESSAGE = (name: string): string =>
  `Nexus global resource "${name}" is already in use by another process.`;

export class GlobalLockHeldError extends Error {
  override readonly name = 'GlobalLockHeldError';

  constructor(public readonly lockName: string) {
    super(GLOBAL_LOCK_ERROR_MESSAGE(lockName));
  }
}

export class GlobalLockTimeoutError extends Error {
  override readonly name = 'GlobalLockTimeoutError';

  constructor(
    public readonly lockName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Timed out waiting for Nexus global resource "${lockName}" after ${timeoutMs}ms.`);
  }
}

export interface GlobalLockHandle {
  release: () => Promise<void>;
}

export interface AcquireGlobalLockOptions {
  retries?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  retryMode?: 'finite' | 'unlimited';
  signal?: AbortSignal;
  onRetry?: (retryCount: number, timeoutMs: number) => void;
  timeoutMs?: number;
}

const abortError = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException('The operation was aborted.', 'AbortError');
};

const waitForRetry = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    throw abortError(signal);
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal as AbortSignal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

export const acquireGlobalLock = async (
  name: string,
  options: AcquireGlobalLockOptions = {},
): Promise<GlobalLockHandle> => {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid global lock name: "${name}". Only alphanumeric characters, underscores, and hyphens are allowed.`);
  }

  const retries = options.retries ?? GLOBAL_LOCK_RETRIES;
  const minTimeout = options.minTimeoutMs ?? GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS;
  const maxTimeout = options.maxTimeoutMs ?? GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS;
  const unlimited = options.retryMode === 'unlimited';
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new RangeError('Global lock retries must be a finite, non-negative integer');
  }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new RangeError('Global lock timeout must be a positive, safe integer');
  }

  const lockfilePath = join(tmpdir(), `nexus-global-${name}.lock`);
  // proper-lockfile requires the target file to exist
  await writeFile(lockfilePath, '', { flag: 'wx' }).catch((err: unknown) => {
    // Ignore only if file already exists
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  });
  let retryCount = 0;
  const startedAt = Date.now();

  while (true) {
    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      throw new GlobalLockTimeoutError(name, options.timeoutMs);
    }
    if (options.signal?.aborted) {
      throw abortError(options.signal);
    }

    try {
      const release = await lockfile.lock(lockfilePath, {
        retries: 0,
        stale: GLOBAL_LOCK_STALE_MS,
      });
      if (options.signal?.aborted) {
        await release().catch(() => {});
        throw abortError(options.signal);
      }
      return { release };
    } catch (error: unknown) {
      if (!isLockHeldError(error)) {
        throw error;
      }
      if (!unlimited && retryCount >= retries) {
        throw new GlobalLockHeldError(name);
      }
      retryCount += 1;
      const timeout = Math.min(maxTimeout, Math.max(minTimeout, minTimeout * 2 ** Math.min(retryCount - 1, 10)));
      let retryTimeout = timeout;
      if (options.timeoutMs !== undefined) {
        const remainingMs = options.timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          throw new GlobalLockTimeoutError(name, options.timeoutMs);
        }
        retryTimeout = Math.min(timeout, remainingMs);
      }
      options.onRetry?.(retryCount, retryTimeout);
      await waitForRetry(retryTimeout, options.signal);
    }
  }
};

const isLockHeldError = (error: unknown): error is Error & { code: string } => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  return Reflect.get(error, 'code') === 'ELOCKED';
};
