# Structured Retrieval and Pipeline Alignment Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. The user explicitly forbids subagents, so execute the plan inline in the current session.

**Goal:** Keep batched legacy and structured embeddings aligned per file and make structured retrieval failure responses conform to the current API contract.

**Architecture:** Preserve the existing three-stage indexing pipeline and change only the flattened embedding input order so it matches the per-work mapping and finalization order. Make the global structured-index gate return complete status metadata, distinguish a missing schema from a future schema, and use the current lower-case unsupported-language reason code consistently.

**Tech Stack:** TypeScript, Vitest, Vitest v8 coverage, ESLint, TypeScript compiler.

## Global Constraints

- Use Node.js >=24 and npm; `package-lock.json` remains authoritative.
- Keep local-first behavior intact; do not transmit source code to external services.
- Keep changes limited to the pipeline alignment, structured retrieval contract, and regression tests.
- Do not create project-level agent configuration files or directories.
- Do not use subagents; commit only after an explicit user request.

---

### Task 1: Lock Pipeline Embedding Alignment With a Regression Test

**Files:**
- Modify: `tests/unit/indexer/pipeline-windowed.test.ts`
- Read: `tests/shared/structured-test-helpers.ts`
- Read: `src/indexer/chunker.ts`

**Interfaces:**
- Consumes: `createStructuredCoordinatorFixture()`, `IndexPipeline`, `Chunker`, `TestEmbeddingProvider`, and `StructuredIndexCoordinator.stageFile()`.
- Produces: A test proving every structured chunk receives the embedding generated from its own content when two structured files share one embedding window.

- [x] **Step 1: Write the failing test**

Import `Chunker` and `createStructuredCoordinatorFixture`, then add this test to the existing windowed-pipeline suite:

```typescript
it('keeps legacy and structured embeddings aligned across files in one window', async () => {
  const {
    metadataStore,
    vectorStore,
    pluginRegistry,
    coordinator,
  } = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });
  const embeddingProvider = new TestEmbeddingProvider();
  const stageFileSpy = vi.spyOn(coordinator, 'stageFile');
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker: new Chunker(pluginRegistry),
    embeddingProvider,
    pluginRegistry,
    structuredIndexCoordinator: coordinator,
    embedBatchWindowSize: 16,
  });
  const files: Record<string, string> = {
    'src/alpha.ts': 'export function alpha() { return 1; }',
    'src/beta.ts': 'export function beta() { return 2; }',
  };

  await pipeline.processEvents(
    Object.keys(files).map((filePath, index) => addEvent(filePath, `hash-${index}`)),
    async (filePath) => files[filePath] ?? '',
  );

  expect(stageFileSpy).toHaveBeenCalledTimes(2);
  for (const [input] of stageFileSpy.mock.calls) {
    await expect(embeddingProvider.embed(input.chunks.map((chunk) => chunk.content))).resolves.toEqual(input.embeddings);
  }
});
```

- [x] **Step 2: Run the focused test to verify the current implementation fails**

Run: `npx vitest run tests/unit/indexer/pipeline-windowed.test.ts --coverage.enabled=false`

Expected: the existing 14 tests pass, but the new alignment test fails because `allChunks` is grouped by chunk kind rather than by file work.

### Task 2: Align the Pipeline’s Flattened Chunk Order

**Files:**
- Modify: `src/indexer/pipeline.ts:446-448`

**Interfaces:**
- Consumes: `toEmbed`, `FileWork.chunks`, and `FileWork.structured.chunks`.
- Produces: `allChunks` ordered as `legacy → structured` for each work, matching `chunkToFilePath` and Stage 3 offsets.

- [x] **Step 1: Replace the grouped flattening with per-work flattening**

Replace the three grouped arrays and concatenation with:

```typescript
const allChunks = toEmbed.flatMap((work) => [
  ...work.chunks,
  ...(work.structured?.chunks ?? []),
]);
```

Keep the existing `chunkToFilePath` loop and Stage 3 offset logic unchanged because both already use the same per-work order.

- [x] **Step 2: Run the pipeline regression test**

Run: `npx vitest run tests/unit/indexer/pipeline-windowed.test.ts --coverage.enabled=false`

Expected: all tests pass, including the new multi-file legacy/structured alignment assertion.

### Task 3: Lock Structured Retrieval Failure Contracts With Regression Tests

**Files:**
- Modify: `tests/unit/structured/retrieval-service.test.ts`
- Read: `tests/unit/storage/in-memory-metadata-store.ts`

**Interfaces:**
- Consumes: `SymbolRetrievalService.getFileOutline()`, `InMemoryMetadataStore`, `PathSanitizer`, and the existing structured rebuild helpers.
- Produces: Tests for missing-schema metadata, future-schema status semantics, and the lower-case unsupported-language reason code.

- [x] **Step 1: Add the missing-schema global-gate test**

Use the existing `catalog` and set its private test-only schema field to `null` with `Object.defineProperty`, then assert the complete response:

```typescript
it('returns complete metadata when the structured schema is missing globally', async () => {
  Object.defineProperty(catalog, 'schemaVersion', { value: null, writable: true });

  await expect(service.getFileOutline({ filePath: 'src/a.ts' })).resolves.toEqual({
    status: 'not_indexed',
    freshness: 'unknown',
    reindexRequired: true,
    reasonCode: 'STRUCTURED_INDEX_MISSING',
    request: { filePath: 'src/a.ts' },
  });
});
```

- [x] **Step 2: Add the future-schema global-gate test**

Set the same test-only schema field to `2` and assert that a future schema is unsupported and does not request reindexing:

```typescript
it('returns unsupported metadata for a future structured schema', async () => {
  Object.defineProperty(catalog, 'schemaVersion', { value: 2, writable: true });

  await expect(service.getFileOutline({ filePath: 'src/a.ts' })).resolves.toEqual({
    status: 'unsupported',
    freshness: 'unknown',
    reindexRequired: false,
    reasonCode: 'STRUCTURED_SCHEMA_UNSUPPORTED',
    request: { filePath: 'src/a.ts' },
  });
});
```

- [x] **Step 3: Add the outline unsupported-language test**

Build and activate a normal structured generation, create a service whose `isSupportedLanguage` accepts only `typescript`, and assert that `getFileOutline` returns `unsupported_language` with the standard metadata:

```typescript
it('returns unsupported_language for an unsupported outline parser', async () => {
  const text = 'export function a() { return 1; }';
  const stage = createStructuredStage('src/a.ts', text, 'a');
  await runStructuredFullRebuild(coordinator, stage);
  await writeFile(join(projectRoot, 'src/a.ts'), text);

  const restrictedService = new SymbolRetrievalService({
    catalog,
    sanitizer,
    isSupportedLanguage: (language) => language === 'typescript',
  });

  await expect(restrictedService.getFileOutline({ filePath: 'src/a.ts' })).resolves.toMatchObject({
    status: 'unsupported',
    freshness: 'unknown',
    reindexRequired: false,
    reasonCode: 'unsupported_language',
  });
});
```

- [x] **Step 4: Run the retrieval tests to verify the current implementation fails**

Run: `npx vitest run tests/unit/structured/retrieval-service.test.ts --coverage.enabled=false`

Expected: the new missing-schema test lacks `freshness` and `reindexRequired`, the future-schema test sees the wrong status and fields, and the outline language test sees `LANGUAGE_UNSUPPORTED`.

### Task 4: Implement the Structured Retrieval Contract Fixes

**Files:**
- Modify: `src/structured/retrieval-service.ts:15-23`
- Modify: `src/structured/retrieval-service.ts:126-132`
- Modify: `src/structured/retrieval-service.ts:339-347`

**Interfaces:**
- Consumes: `StructuredIndexState.schemaVersion`, the existing `SourceStatus` union, and the current `structuredRetrievalReasonCode` convention.
- Produces: Complete global failure responses and a consistent unsupported-language reason code for outline retrieval.

- [x] **Step 1: Make global-state results complete and semantically distinct**

Change `checkGlobalState` to return these two complete shapes:

```typescript
type GlobalStateStatus =
  | {
      status: 'not_indexed';
      freshness: 'unknown';
      reindexRequired: true;
      reasonCode: 'STRUCTURED_INDEX_MISSING';
    }
  | {
      status: 'unsupported';
      freshness: 'unknown';
      reindexRequired: false;
      reasonCode: 'STRUCTURED_SCHEMA_UNSUPPORTED';
    };
```

Return the first shape for `schemaVersion === null` and the second shape for `schemaVersion !== 1`. The existing callers can continue spreading the result and adding their request payload, so both outline and symbol global-gate responses receive the metadata.

- [x] **Step 2: Normalize the outline language reason code**

Change only the `getFileOutline` unsupported-language branch from `LANGUAGE_UNSUPPORTED` to `unsupported_language`. Leave the schema reason code uppercase because it is a separate stable catalog-state code.

- [x] **Step 3: Run both focused test files**

Run: `npx vitest run tests/unit/indexer/pipeline-windowed.test.ts tests/unit/structured/retrieval-service.test.ts --coverage.enabled=false`

Expected: all existing and new tests pass.

### Task 5: Run Repository Verification

**Files:**
- Verify: `src/indexer/pipeline.ts`
- Verify: `src/structured/retrieval-service.ts`
- Verify: `tests/unit/indexer/pipeline-windowed.test.ts`
- Verify: `tests/unit/structured/retrieval-service.test.ts`

**Interfaces:**
- Consumes: The completed implementation and regression tests.
- Produces: Evidence that behavior, types, lint rules, and the broader test suite remain valid.

- [x] **Step 1: Run the complete Vitest suite without the shared coverage artifact race**

Run: `npx vitest run --coverage.enabled=false`

Expected: every test file passes with zero failed tests.

- [x] **Step 2: Run TypeScript type checking**

Run: `npx tsc --noEmit`

Expected: the compiler exits successfully without diagnostics.

- [x] **Step 3: Run ESLint**

Run: `npm run lint`

Expected: ESLint exits successfully without errors.

- [x] **Step 4: Confirm the final scope**

Review the edited files and confirm that only the two production files, the two focused test files, and this implementation plan contain changes. Commit only after an explicit user request.
