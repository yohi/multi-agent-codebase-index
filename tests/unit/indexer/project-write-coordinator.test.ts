import { describe, expect, it } from 'vitest';

import { ProjectWriteCoordinator } from '../../../src/indexer/project-write-coordinator.js';

describe('ProjectWriteCoordinator', () => {
  it('reports whether a write operation currently holds the lock', async () => {
    const coordinator = new ProjectWriteCoordinator();
    expect(await coordinator.isLocked()).toBe(false);

    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveOperation: (() => void) | undefined;
    const operation = coordinator.run(async () => {
      resolveStarted?.();
      await new Promise<void>((resolve) => {
        resolveOperation = resolve;
      });
    });

    await started;
    expect(await coordinator.isLocked()).toBe(true);

    resolveOperation?.();
    await operation;
    expect(await coordinator.isLocked()).toBe(false);
  });

  it('rejects a queued operation after the configured lock timeout', async () => {
    const coordinator = new ProjectWriteCoordinator({ lockTimeoutMs: 20 });
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveOperation: (() => void) | undefined;
    const heldOperation = coordinator.run(async () => {
      resolveStarted?.();
      await new Promise<void>((resolve) => {
        resolveOperation = resolve;
      });
    });

    await started;
    await expect(coordinator.run(async () => {})).rejects.toThrow();

    resolveOperation?.();
    await heldOperation;
  });
});
