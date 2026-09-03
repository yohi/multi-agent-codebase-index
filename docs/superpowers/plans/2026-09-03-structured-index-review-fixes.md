# Structured Index Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five validated structured-index review findings while leaving the empty shadow-table swap behavior unchanged.

**Architecture:** Keep the existing storage and coordinator boundaries. Preserve an empty structured LanceDB table handle after reconciliation, propagate the catalog epoch through per-file staging, derive chunk ranges from the actual raw source span, apply an optional mutex timeout, and make the in-memory vector test double use the same deduplication policy as LanceDB.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest, LanceDB 0.18.x, `async-mutex` 0.5.x.

## Global Constraints

- Do not use subagents; execute the plan inline.
- Do not modify or stage existing unrelated worktree changes.
- Do not change `swapStructuredShadowTable()` for the empty-shadow case.
- Preserve the default indefinite wait behavior when `lockTimeoutMs` is omitted.
- Run `npx vitest run <test-file>`, `npm run lint`, and `npx tsc --noEmit` before completion.

---

### Task 1: Preserve the empty structured table handle

**Files:**
- Modify: `src/storage/vector-store.ts:837-843`
- Test: `tests/shared/vector-store-contract.ts:192-249`

**Interfaces:**
- Consumes: `IVectorStore.reconcileStructuredRows()` and `IVectorStore.stageGenerationChunks()`.
- Produces: A store that can stage and activate a new generation after reconciling with an empty active-generation list.

- [x] **Step 1: Write the failing contract test**

Add this test after the existing reconciliation test:

```ts
it('stages a new generation after reconciling all structured rows', async () => {
  await stageGeneration(store, { filePath: 'src/a.ts', generationId: 'gen-1', chunkId: 'a1', symbolId: 'symbol-1' });
  await store.activateGenerationRows('src/a.ts', 'gen-1');
  await store.reconcileStructuredRows([]);

  await stageGeneration(store, { filePath: 'src/b.ts', generationId: 'gen-2', chunkId: 'b1', symbolId: 'symbol-2' });
  await store.activateGenerationRows('src/b.ts', 'gen-2');

  await expectSearchResults(store, { count: 1, chunkId: 'b1', generationId: 'gen-2' });
});
```

- [x] **Step 2: Run the contract test and verify the LanceDB failure**

Run: `npx vitest run tests/integration/vector-store.test.ts tests/unit/storage/in-memory-vector-store.test.ts`

Expected: the new LanceDB contract case fails because `createTable('structured_chunks', rows)` is called while the physical table still exists; the in-memory case passes.

- [x] **Step 3: Apply the minimal implementation**

In `reconcileStructuredRows()`, keep the table handle after deleting all rows:

```ts
if (activeGenerations.length === 0) {
  await this.structuredTable.delete('true');
  return;
}
```

- [x] **Step 4: Run the contract test and verify the fix**

Run: `npx vitest run tests/integration/vector-store.test.ts tests/unit/storage/in-memory-vector-store.test.ts`

Expected: all vector-store contract tests pass.

### Task 2: Preserve the catalog rebuild epoch during staging

**Files:**
- Modify: `src/indexer/structured-index-coordinator.ts:28-31`
- Test: `tests/unit/structured/structured-index-coordinator.test.ts:72-144`

**Interfaces:**
- Consumes: `IStructuredCatalog.getStructuredIndexState()` and `stageGeneration()`.
- Produces: `stageFile()` requests carrying the current catalog `rebuildEpoch` instead of a wall-clock value.

- [x] **Step 1: Write the failing epoch propagation test**

Add this test before the existing failure-recovery case:

```ts
it('preserves the catalog rebuild epoch while staging a file', async () => {
  const stage = makeStage('src/a.ts', 'export function a() { return 1; }', 'a');

  expect((await metadataStore.getStructuredIndexState()).rebuildEpoch).toBe(0);
  await stageCoordinatorFile(coordinator, stage);

  expect((await metadataStore.getStructuredIndexState()).rebuildEpoch).toBe(0);
});
```

- [x] **Step 2: Run the focused test and verify the failure**

Run: `npx vitest run tests/unit/structured/structured-index-coordinator.test.ts`

Expected: the new test fails because `stageFile()` persists `Date.now()` into the in-memory catalog epoch.

- [x] **Step 3: Apply the minimal implementation**

Use the state value already read by `stageFile()`:

```ts
const rebuildEpoch = state.rebuildEpoch;
```

- [x] **Step 4: Run the focused test and verify the fix**

Run: `npx vitest run tests/unit/structured/structured-index-coordinator.test.ts`

Expected: all structured coordinator tests pass and the epoch remains `0` during per-file staging.

### Task 3: Keep oversized raw-source chunk ranges and IDs consistent

**Files:**
- Modify: `src/indexer/chunker.ts:71-100`
- Test: `tests/unit/indexer/chunker.test.ts:186-241`

**Interfaces:**
- Consumes: `StructuredDeclaration.rawSource`, `StructuredDeclaration.position`, and `Chunker.splitByMaxChars()`.
- Produces: Subchunks whose line ranges describe the raw source span and whose IDs encode the final line ranges.

- [x] **Step 1: Write the failing Go raw-source regression test**

Add this test in the `maxChunkChars` describe block:

```ts
it('keeps raw-source subchunk ranges and IDs aligned with leading Go comments', async () => {
  const rawSource = [
    '//go:noinline',
    '// Open opens a resource.',
    'func Open() {',
    '  return',
    '}',
  ].join('\n');
  const bytes = Buffer.from(rawSource, 'utf8');
  const declaration: StructuredDeclaration = {
    name: 'Open',
    symbolId: 'symbol-open',
    qualifiedName: 'Open',
    kind: 'function',
    signatureDiscriminator: 'Open()',
    position: { startLine: 3, startColumn: 0, endLine: 5, endColumn: 1 },
    startByte: 0,
    endByte: bytes.length,
    sourceHash: 'hash-open',
    languageId: 'go',
    isExact: true,
    rawSource,
  };
  const chunker = new Chunker(new PluginRegistry(), { maxChunkChars: 20 });

  const chunks = await chunker.chunkStructuredFile(
    { filePath: 'src/open.go', language: 'go', content: rawSource, bytes },
    { declarations: [declaration], imports: [] },
  );

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[0]?.startLine).toBe(1);
  expect(chunks.every((chunk) => chunk.startLine <= chunk.endLine)).toBe(true);
  expect(chunks.every((chunk) => chunk.id.includes(`${chunk.startLine}-${chunk.endLine}:`))).toBe(true);
});
```

- [x] **Step 2: Run the focused test and verify the failure**

Run: `npx vitest run tests/unit/indexer/chunker.test.ts`

Expected: the new test fails because the current implementation starts splitting at line `3`, clamps only `endLine`, and leaves IDs based on the pre-clamped ranges.

- [x] **Step 3: Apply the minimal implementation**

In `extractDeclarationChunks()`, derive the raw-source start line from its end line and line count, pass that start line to `splitByMaxChars()`, and after clamping regenerate each multi-part ID from the final range and original part number:

```ts
const contentStartLine = declaration.rawSource === undefined
  ? declaration.position.startLine
  : Math.max(1, declaration.position.endLine - this.countLines(content) + 1);
const subChunks = await this.splitByMaxChars(
  content,
  contentStartLine,
  declaration.name,
  file.filePath,
  base,
);

if (declaration.rawSource !== undefined && subChunks.length > 1) {
  const endLine = declaration.position.endLine;
  for (const [index, chunk] of subChunks.entries()) {
    chunk.endLine = Math.max(chunk.startLine, Math.min(chunk.endLine, endLine));
    chunk.id = this.createChunkId(
      file.filePath,
      chunk.startLine,
      chunk.endLine,
      `${declaration.name}-part${index + 1}`,
    );
  }
}
```

- [x] **Step 4: Run the focused tests and verify the fix**

Run: `npx vitest run tests/unit/indexer/chunker.test.ts tests/unit/structured/go-parser.test.ts`

Expected: all chunker and Go parser tests pass.

### Task 4: Enforce the optional project lock timeout

**Files:**
- Modify: `src/indexer/project-write-coordinator.ts:1-18`
- Test: `tests/unit/indexer/project-write-coordinator.test.ts:5-29`

**Interfaces:**
- Consumes: `ProjectWriteCoordinatorOptions.lockTimeoutMs` and `async-mutex.withTimeout()`.
- Produces: A coordinator that rejects queued writes after the configured timeout while retaining existing behavior when the option is absent.

- [x] **Step 1: Write the failing timeout test**

Add this test after the existing lock-state test:

```ts
it('rejects a queued operation after the configured lock timeout', async () => {
  const coordinator = new ProjectWriteCoordinator({ lockTimeoutMs: 20 });
  let markStarted!: () => void;
  let releaseOperation!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const held = coordinator.run(async () => {
    markStarted();
    await new Promise<void>((resolve) => { releaseOperation = resolve; });
  });

  await started;
  await expect(coordinator.run(async () => {})).rejects.toThrow();

  releaseOperation();
  await held;
});
```

- [x] **Step 2: Run the focused test and verify the failure**

Run: `npx vitest run tests/unit/indexer/project-write-coordinator.test.ts`

Expected: the new test fails because `lockTimeoutMs` is currently ignored by the raw mutex.

- [x] **Step 3: Apply the minimal implementation**

Construct a `MutexInterface` and wrap it only when a timeout is explicitly configured:

```ts
import { Mutex, type MutexInterface, withTimeout } from 'async-mutex';

export class ProjectWriteCoordinator {
  private readonly mutex: MutexInterface;

  constructor(options: ProjectWriteCoordinatorOptions = {}) {
    const mutex = new Mutex();
    this.mutex = options.lockTimeoutMs === undefined
      ? mutex
      : withTimeout(mutex, options.lockTimeoutMs);
  }
```

- [x] **Step 4: Run the focused test and verify the fix**

Run: `npx vitest run tests/unit/indexer/project-write-coordinator.test.ts tests/unit/structured/structured-index-coordinator.test.ts`

Expected: the timeout test rejects the queued operation and all coordinator tests pass.

### Task 5: Match in-memory search deduplication with LanceDB

**Files:**
- Modify: `tests/unit/storage/in-memory-vector-store.ts:184-223`
- Test: `tests/shared/vector-store-contract.ts:161-249`

**Interfaces:**
- Consumes: Legacy and active structured `VectorSearchResult` candidates.
- Produces: In-memory search results with the same ordering, `chunk.id` deduplication, and `topK` behavior as LanceDB.

- [x] **Step 1: Write the failing contract test**

Add this test after the legacy-result test:

```ts
it('deduplicates a chunk ID shared by legacy and structured rows', async () => {
  await upsertChunks(store, [makeChunk({ id: 'duplicate', filePath: 'src/duplicate.ts' })]);
  await stageGeneration(store, { filePath: 'src/duplicate.ts', generationId: 'gen-1', chunkId: 'duplicate', symbolId: 'symbol-1' });
  await store.activateGenerationRows('src/duplicate.ts', 'gen-1');

  const results = await store.search(embedding, 10);

  expect(results).toHaveLength(1);
  expect(results[0]?.chunk.id).toBe('duplicate');
  expect(results[0]?.generationId).toBe('gen-1');
});
```

- [x] **Step 2: Run the contract test and verify the in-memory failure**

Run: `npx vitest run tests/unit/storage/in-memory-vector-store.test.ts tests/integration/vector-store.test.ts`

Expected: the in-memory test returns two results for the same ID while the LanceDB implementation returns one.

- [x] **Step 3: Apply the minimal implementation**

Replace the final in-memory candidate pipeline with the LanceDB-equivalent order, deduplication, and limit:

```ts
const seen = new Set<string>();
const combined: VectorSearchResult[] = [];
const candidates = [...structuredCandidates, ...legacyCandidates]
  .filter((candidate) => {
    if (filter?.filePathPrefix !== undefined && !candidate.chunk.filePath.startsWith(filter.filePathPrefix)) return false;
    if (filter?.language !== undefined && candidate.chunk.language !== filter.language) return false;
    if (filter?.symbolKind !== undefined && candidate.chunk.symbolKind !== filter.symbolKind) return false;
    return true;
  })
  .sort((left, right) => right.score - left.score || left.chunk.filePath.localeCompare(right.chunk.filePath));

for (const candidate of candidates) {
  if (seen.has(candidate.chunk.id)) continue;
  seen.add(candidate.chunk.id);
  combined.push(candidate);
  if (combined.length >= topK) break;
}

return combined.slice(0, topK);
```

- [x] **Step 4: Run the focused tests and verify the fix**

Run: `npx vitest run tests/unit/storage/in-memory-vector-store.test.ts tests/integration/vector-store.test.ts`

Expected: both implementations pass the shared vector-store contract.

### Task 6: Run repository quality gates and commit the implementation

**Files:**
- Verify: all files modified by Tasks 1-5 and the approved implementation plan.

**Interfaces:**
- Consumes: The passing regression and existing test suites.
- Produces: A verified implementation commit containing only the plan and intended source/test files.

- [x] **Step 1: Run focused regression tests**

Run: `npx vitest run tests/integration/vector-store.test.ts tests/unit/storage/in-memory-vector-store.test.ts tests/unit/indexer/chunker.test.ts tests/unit/indexer/project-write-coordinator.test.ts tests/unit/structured/structured-index-coordinator.test.ts tests/unit/structured/go-parser.test.ts`

Expected: all selected test files pass. If coverage output collides, rerun the same command as one Vitest process rather than running multiple coverage-enabled processes in parallel.

- [x] **Step 2: Run lint and type checking**

Run: `npm run lint` and `npx tsc --noEmit`

Expected: both commands exit successfully without errors.

- [x] **Step 3: Run the build**

Run: `npm run build`

Expected: the root package and dashboard build successfully.

- [x] **Step 4: Run the complete test suite**

Run: `npx vitest run`

Expected: all test files pass.

- [x] **Step 5: Inspect the final change set**

Run: `git status --short --branch`, `git diff --stat HEAD`, and `git diff HEAD -- src/indexer/chunker.ts src/indexer/project-write-coordinator.ts src/indexer/structured-index-coordinator.ts src/storage/vector-store.ts tests/shared/vector-store-contract.ts tests/unit/indexer/chunker.test.ts tests/unit/indexer/project-write-coordinator.test.ts tests/unit/storage/in-memory-vector-store.ts tests/unit/structured/structured-index-coordinator.test.ts docs/superpowers/plans/2026-09-03-structured-index-review-fixes.md`

Expected: only intended files are included in the new change set; existing modifications to `docs/superpowers/plans/2026-08-28-structured-symbol-retrieval.md` and `REQUIREMENTS-20260827.md` remain unstaged and untouched.

- [x] **Step 6: Commit the implementation**

Run:

```bash
git add src/indexer/chunker.ts src/indexer/project-write-coordinator.ts src/indexer/structured-index-coordinator.ts src/storage/vector-store.ts tests/shared/vector-store-contract.ts tests/unit/indexer/chunker.test.ts tests/unit/indexer/project-write-coordinator.test.ts tests/unit/storage/in-memory-vector-store.ts tests/unit/structured/structured-index-coordinator.test.ts docs/superpowers/plans/2026-09-03-structured-index-review-fixes.md
git commit -m "fix: 構造化インデックスの整合性を修正"
```

Expected: one implementation commit is created without including unrelated worktree changes.

- [x] **Step 7: Push the current feature branch**

Run: `git push origin feat/structured-indexing`

Expected: the implementation commit is pushed to `origin/feat/structured-indexing`.
