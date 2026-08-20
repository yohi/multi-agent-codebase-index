import { describe, expect, it } from 'vitest';

import { EventQueue } from '../../../src/indexer/event-queue.js';

const makeEvent = (filePath: string) => ({
  type: 'added' as const,
  filePath,
  detectedAt: new Date().toISOString(),
});

const makeQueue = (overrides: { maxQueueSize?: number; fullScanThreshold?: number; onFullScanRequired?: () => Promise<void> } = {}) =>
  new EventQueue({
    debounceMs: 0,
    maxQueueSize: overrides.maxQueueSize ?? 100,
    fullScanThreshold: overrides.fullScanThreshold ?? 50,
    concurrency: 1,
    onFullScanRequired: overrides.onFullScanRequired,
  });

describe('EventQueue post-scan queue', () => {
  it('buffers events without applying normal queue semantics', () => {
    const queue = makeQueue({ maxQueueSize: 2, fullScanThreshold: 1 });
    queue.enterPostScanMode();

    expect(queue.enqueue(makeEvent('a.ts'))).toBe(true);
    expect(queue.enqueue(makeEvent('b.ts'))).toBe(true);
    expect(queue.enqueue(makeEvent('c.ts'))).toBe(true);
    expect(queue.getPostScanQueueSize()).toBe(3);
    expect(queue.getState()).toBe('normal');
    expect(queue.size()).toBe(0);
  });

  it('moves buffered events into the normal watcher queue when drained', () => {
    const queue = makeQueue();
    queue.enterPostScanMode();
    queue.enqueue(makeEvent('a.ts'));
    queue.enqueue(makeEvent('b.ts'));

    expect(queue.drainPostScanQueue()).toBe(2);
    expect(queue.isPostScanActive()).toBe(false);
    expect(queue.getPostScanQueueSize()).toBe(0);
    expect(queue.size()).toBe(2);
    expect(queue.drainPostScanQueue()).toBe(0);
  });

  it('preserves post-scan events when normal full-scan state completes', async () => {
    let fullScanTriggered = false;
    const queue = makeQueue({
      maxQueueSize: 2,
      fullScanThreshold: 1,
      onFullScanRequired: async () => {
        fullScanTriggered = true;
      },
    });

    queue.enterPostScanMode();
    queue.enqueue(makeEvent('post-1.ts'));
    queue.enqueue(makeEvent('post-2.ts'));
    queue.enqueue(makeEvent('post-3.ts'));
    expect(queue.getPostScanQueueSize()).toBe(3);

    queue.markFullScanComplete();
    expect(queue.getPostScanQueueSize()).toBe(3);
    expect(queue.isPostScanActive()).toBe(true);

    queue.drainPostScanQueue();
    queue.enqueue(makeEvent('normal-1.ts'));
    queue.enqueue(makeEvent('normal-2.ts'));
    queue.enqueue(makeEvent('overflow.ts'));
    await queue.drain(async () => undefined);

    expect(fullScanTriggered).toBe(true);
    expect(queue.getState()).toBe('full_scan');

    queue.enterPostScanMode();
    queue.enqueue(makeEvent('post-4.ts'));
    queue.markFullScanComplete();
    expect(queue.getState()).toBe('normal');
    expect(queue.getPostScanQueueSize()).toBe(1);
    expect(queue.isPostScanActive()).toBe(true);
  });

  it('aborts post-scan mode without forwarding buffered events', () => {
    const queue = makeQueue();
    queue.enterPostScanMode();
    queue.enqueue(makeEvent('a.ts'));
    queue.abortPostScanMode();

    expect(queue.isPostScanActive()).toBe(false);
    expect(queue.getPostScanQueueSize()).toBe(0);
    expect(queue.size()).toBe(0);
  });
});
