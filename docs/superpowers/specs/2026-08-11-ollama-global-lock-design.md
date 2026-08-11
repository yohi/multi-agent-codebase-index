# Ollama Global Lock Queuing Design

## Context

GitHub Issue: <https://github.com/yohi/nexus/issues/244>

When running concurrent indexing or multiple Nexus instances that all use Ollama embeddings, the second process fails with `GlobalLockHeldError` after about 10 seconds:

```text
Indexing failed: GlobalLockHeldError: Nexus global resource "ollama" is already in use by another process.
```

The current `acquireGlobalLock` implementation in `src/utils/global-lock.ts` retries only 10 times with a maximum 1-second back-off, giving a total wait time of roughly 10 seconds. `OllamaEmbeddingProvider.embed` in `src/plugins/embeddings/ollama.ts` holds that lock across an entire `embed()` call, which routinely takes longer than 10 seconds. Any parallel Ollama consumer therefore times out and crashes its indexing task.

## Goal

Allow concurrent Ollama embedding requests to wait gracefully for the global `ollama` lock instead of failing after a short, hard-coded timeout.

## Non-Goals

- Integrate the lock with the HTTP Bridge or project-level locks.
- Reduce lock granularity to individual batches.
- Introduce a shared process queue for Ollama requests.

## Design

### 1. Make `acquireGlobalLock` configurable

`src/utils/global-lock.ts` currently hard-codes the `proper-lockfile` retry settings. We will extend `acquireGlobalLock` to accept an optional `options` argument while preserving the existing defaults for all other callers.

```typescript
export interface AcquireGlobalLockOptions {
  retries?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  retryMode?: 'finite' | 'unlimited';
  signal?: AbortSignal;
}

export const acquireGlobalLock = async (
  name: string,
  options: AcquireGlobalLockOptions = {},
): Promise<GlobalLockHandle> => {
  // ... validation unchanged ...

  // proper-lockfile is always called with retries: 0. Application-level retry
  // logic handles only ELOCKED and observes options.signal between attempts.
  const release = await lockfile.lock(lockfilePath, {
    retries: 0,
    stale: GLOBAL_LOCK_STALE_MS,
  });

  // ...
};
```

Default behavior is unchanged:

- `GLOBAL_LOCK_RETRIES = 10`
- `GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS = 100`
- `GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS = 1000`
- `GLOBAL_LOCK_STALE_MS = 60_000`

### 2. Request indefinite queuing for Ollama embeddings

`src/plugins/embeddings/ollama.ts` will pass custom retry options when acquiring the `ollama` lock:

```typescript
const lock = await acquireGlobalLock('ollama', {
  retryMode: 'unlimited',
  maxTimeoutMs: 5_000,
  signal,
});
```

Rationale:

- `retryMode: 'unlimited'` lets callers wait until the lock is released without passing `Infinity` to proper-lockfile. The application-level loop retries only ELOCKED failures and observes `signal` while waiting.
- `maxTimeoutMs: 5_000` spaces retry attempts up to 5 seconds, reducing lock-file polling overhead while still allowing quick acquisition when the lock is released.
- The `stale: 60_000` option in `proper-lockfile` already recovers from stale locks, so an infinite wait will not hang forever if the holding process dies.
- Lock scope remains the entire `embed()` call (all batches). Keeping the lock coarse keeps Ollama's local model queue efficient and avoids per-batch lock thrashing.

### 3. Tests

- `tests/unit/utils/global-lock.test.ts`: verify real ELOCKED retry acquisition after release, stale-lock recovery, cancellation of unlimited waits, and unchanged propagation of non-lock errors.
- `tests/unit/plugins/embeddings/ollama.test.ts`: verify delayed lock acquisition, signal propagation, release after post-acquisition cancellation, and cancellation of an in-flight request.

## Error Handling

- Non-lock errors from `proper-lockfile` continue to propagate unchanged.
- When the lock is genuinely held by another live process, the Ollama provider retries only the lock-held error instead of throwing `GlobalLockHeldError` immediately.
- Cancellation aborts the lock wait and propagates through `embed()` and indexing/shutdown. If cancellation is observed immediately after acquisition, the provider releases the lock before propagating the cancellation.
- If the holding process crashes without releasing the lock, `proper-lockfile`'s `stale` mechanism releases the lock after `GLOBAL_LOCK_STALE_MS` (60 seconds), allowing waiters to proceed.

## Risks and Trade-offs

| Concern | Mitigation |
| --- | --- |
| Unlimited wait could appear to hang | Expected behavior per the issue: queue until available. Existing stale-lock recovery prevents permanent hangs from dead holders, and AbortSignal cancels shutdown waits. |
| Coarse lock keeps Ollama serialized | Intentional: Ollama runs a single local model; serializing embedding work is more efficient than interleaving small batches from multiple processes. |
| Other global-resource consumers keep short timeout | Options object preserves default behavior for all non-Ollama callers. |

## Verification

1. `npm run lint` passes.
2. `npx vitest run tests/unit/utils/global-lock.test.ts` passes.
3. `npx vitest run tests/unit/plugins/embeddings/ollama.test.ts` passes.
4. `npx vitest run` passes when shared behavior is affected.

## Future Work

- Consider a dedicated Ollama HTTP Bridge route so CLI reindexing can delegate embedding work to an already-running Nexus server instead of competing for the local Ollama instance.
- Consider exposing the lock wait parameters in user configuration if different deployment sizes need different timeouts.
