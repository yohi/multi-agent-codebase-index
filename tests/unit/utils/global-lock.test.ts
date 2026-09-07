import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import lockfile from 'proper-lockfile';
import {
  acquireGlobalLock,
  GlobalLockHeldError,
  GlobalLockTimeoutError,
  GLOBAL_LOCK_RETRIES,
  GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS,
  GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS,
  GLOBAL_LOCK_STALE_MS,
  projectStartupLockName,
} from '../../../src/utils/global-lock.js';

describe('global-lock', () => {
  it('acquires and releases a global lock', async () => {
    const name = `test-${randomUUID()}`;
    const lock = await acquireGlobalLock(name);
    await lock.release();
  });

  it('throws a GlobalLockHeldError when another instance holds the same global lock', async () => {
    const name = `test-${randomUUID()}`;
    const lock = await acquireGlobalLock(name);
    try {
      const error = await acquireGlobalLock(name).catch((caught) => caught);
      expect(error).toBeInstanceOf(GlobalLockHeldError);
      expect((error as GlobalLockHeldError).lockName).toBe(name);
    } finally {
      await lock.release();
    }
  });

  it('retries ELOCKED acquisition until the held lock is released', async () => {
    const name = `test-${randomUUID()}`;
    const heldLock = await acquireGlobalLock(name);
    const retryNotifications: Array<{ retryCount: number; timeoutMs: number }> = [];
    let resolveFirstRetry: (() => void) | undefined;
    const firstRetryNotification = new Promise<void>((resolve) => {
      resolveFirstRetry = resolve;
    });

    const waitingLock = acquireGlobalLock(name, {
      retries: 10,
      minTimeoutMs: 10,
      maxTimeoutMs: 10,
      onRetry: (retryCount, timeoutMs) => {
        retryNotifications.push({ retryCount, timeoutMs });
        if (retryCount === 1) {
          resolveFirstRetry?.();
        }
      },
    });
    await firstRetryNotification;
    await heldLock.release();

    const acquiredLock = await waitingLock;
    await acquiredLock.release();
    expect(retryNotifications[0]).toEqual({ retryCount: 1, timeoutMs: 10 });
  });

  it('fails unlimited acquisition after the configured timeout', async () => {
    const name = `test-${randomUUID()}`;
    const heldLock = await acquireGlobalLock(name);

    try {
      await expect(
        acquireGlobalLock(name, {
          retryMode: 'unlimited',
          timeoutMs: 25,
          minTimeoutMs: 10,
          maxTimeoutMs: 10,
        }),
      ).rejects.toMatchObject({
        name: 'GlobalLockTimeoutError',
        lockName: name,
        timeoutMs: 25,
      } satisfies Partial<GlobalLockTimeoutError>);
    } finally {
      await heldLock.release();
    }
  });

  it('does not report a timeout when no overall timeout is configured', async () => {
    const name = `test-${randomUUID()}`;
    const heldLock = await acquireGlobalLock(name);

    try {
      await expect(
        acquireGlobalLock(name, {
          retries: 1,
          minTimeoutMs: 0,
          maxTimeoutMs: 0,
        }),
      ).rejects.toBeInstanceOf(GlobalLockHeldError);
    } finally {
      await heldLock.release();
    }
  });

  it('recovers a stale global lock', async () => {
    const name = `test-${randomUUID()}`;
    const lockfilePath = join(tmpdir(), `nexus-global-${name}.lock`);
    const heldLock = await acquireGlobalLock(name);

    try {
      const staleTime = new Date(Date.now() - GLOBAL_LOCK_STALE_MS - 1000);
      await utimes(`${lockfilePath}.lock`, staleTime, staleTime);

      const recoveredLock = await acquireGlobalLock(name, {
        retries: 0,
      });
      await recoveredLock.release();
    } finally {
      await heldLock.release().catch(() => {});
    }
  });

  it('cancels an unlimited lock wait without acquiring the lock', async () => {
    const name = `test-${randomUUID()}`;
    const heldLock = await acquireGlobalLock(name);
    const controller = new AbortController();

    try {
      const waitingLock = acquireGlobalLock(name, {
        retryMode: 'unlimited',
        minTimeoutMs: 10,
        maxTimeoutMs: 10,
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort();

      await expect(waitingLock).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await heldLock.release();
    }
  });

  it('propagates non-lock acquisition errors unchanged', async () => {
    const name = `test-${randomUUID()}`;
    const expected = new Error('permission denied');
    const lockSpy = vi.spyOn(lockfile, 'lock').mockRejectedValueOnce(expected);

    try {
      await expect(acquireGlobalLock(name)).rejects.toBe(expected);
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('different names do not conflict', async () => {
    const name1 = `test-${randomUUID()}`;
    const name2 = `test-${randomUUID()}`;
    const lock1 = await acquireGlobalLock(name1);
    const lock2 = await acquireGlobalLock(name2);
    await lock1.release();
    await lock2.release();
  });

  it('uses bounded proper-lockfile stale and retry policy', () => {
    expect(GLOBAL_LOCK_STALE_MS).toBe(60_000);
    expect(GLOBAL_LOCK_RETRIES).toBe(10);
    expect(GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS).toBe(100);
    expect(GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS).toBe(1000);
  });

  it('derives the same startup lock for a symlink storage alias', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'nexus-global-lock-'));
    const storageAlias = join(tmpdir(), `nexus-global-lock-alias-${randomUUID()}`);

    try {
      await symlink(storageDir, storageAlias, 'dir');

      const targetLock = await projectStartupLockName(storageDir);

      expect(targetLock).toMatch(/^project-start-[a-f0-9]{64}$/);
      await expect(projectStartupLockName(storageAlias)).resolves.toBe(targetLock);
    } finally {
      await rm(storageAlias, { force: true });
      await rm(storageDir, { force: true, recursive: true });
    }
  });

  it('derives different startup locks for different storage directories', async () => {
    const storageDir1 = await mkdtemp(join(tmpdir(), 'nexus-global-lock-1-'));
    const storageDir2 = await mkdtemp(join(tmpdir(), 'nexus-global-lock-2-'));

    try {
      const lock1 = await projectStartupLockName(storageDir1);
      const lock2 = await projectStartupLockName(storageDir2);
      expect(lock1).not.toBe(lock2);
    } finally {
      await rm(storageDir1, { force: true, recursive: true });
      await rm(storageDir2, { force: true, recursive: true });
    }
  });
});
