# Sonar Quality Gate Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a passing SonarCloud quality gate for PR #274 without weakening Sonar configuration or changing structured retrieval behavior.

**Architecture:** Keep all changes in benchmark and test code. Centralize repeated structured source, coordinator, and stage fixture setup in `tests/shared/structured-test-helpers.ts`; extend the existing test-options factory so the HTTP integration test can reuse its typed runtime options instead of repeating server dependencies. Generate temporary directories with Node's `mkdtemp()`.

**Tech Stack:** Node.js >=24, TypeScript, Vitest, Node `fs/promises`, in-memory metadata/vector stores, SonarCloud.

## Global Constraints

- Preserve the existing structured retrieval assertions and production API surface.
- Keep unrelated working-tree changes untouched.
- Use the OS-managed `mkdtemp()` API instead of `Math.random()` for temporary directory uniqueness.
- Use existing in-memory stores and typed helper inputs; do not add production dependencies.
- Run affected Vitest files first, then the full Vitest suite, `npm run lint`, `npx tsc --noEmit`, and `npm run build`.
- Do not change Sonar exclusions or commit changes unless explicitly requested.

---

### Task 1: Lock the shared test-helper contract

**Files:**
- Create: `tests/shared/structured-test-helpers.test.ts`
- Create: `tests/shared/structured-test-helpers.ts`
- Modify: `tests/shared/create-test-nexus-options.ts`

**Interfaces:**
- Produces `createStructuredSource(filePath, text): StructuredSource`.
- Produces `createStructuredCoordinatorFixture({ bootstrapStructuredSchema? }): Promise<StructuredCoordinatorFixture>`.
- Produces `createStructuredCoordinator({ metadataStore, vectorStore, pluginRegistry }): StructuredIndexCoordinator`.
- Produces `createStructuredStage(filePath, text, qualifiedName, options?): StructuredStageFixture`.
- Produces `stageStructuredFile(coordinator, stage): Promise<void>` and `runStructuredFullRebuild(coordinator, stage): Promise<void>`.
- Extends `createTestNexusOptions({ projectRoot?, fileContent?, chunkContent?, bootstrapStructuredSchema?, metricsHooks? })` while preserving its no-argument defaults.

- [x] **Step 1: Write failing helper-contract tests**

```typescript
import { describe, expect, it } from 'vitest';

import { createTestNexusOptions } from './create-test-nexus-options.js';
import {
  createStructuredCoordinatorFixture,
  createStructuredSource,
} from './structured-test-helpers.js';

describe('structured test helpers', () => {
  it('preserves UTF-8 text and bytes in a structured source', () => {
    const source = createStructuredSource('src/café.ts', 'export const café = "狐";');

    expect(source.text).toBe('export const café = "狐";');
    expect(Buffer.from(source.bytes).toString('utf8')).toBe(source.text);
  });

  it('bootstraps the structured schema only when requested', async () => {
    const legacy = await createStructuredCoordinatorFixture();
    const structured = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });

    await expect(legacy.metadataStore.getStructuredIndexState()).resolves.toMatchObject({ schemaVersion: null });
    await expect(structured.metadataStore.getStructuredIndexState()).resolves.toMatchObject({ schemaVersion: 1 });
  });

  it('builds test server options for a custom project and fixture content', async () => {
    const content = 'export function authenticate() { return true; }';
    const context = await createTestNexusOptions({
      projectRoot: process.cwd(),
      fileContent: content,
      chunkContent: content,
      bootstrapStructuredSchema: true,
    });

    expect(context.options.projectRoot).toBe(process.cwd());
    await expect(context.metadataStore.getStructuredIndexState()).resolves.toMatchObject({ schemaVersion: 1 });
    await expect(context.options.loadFileContent('src/auth.ts')).resolves.toBe(content);
  });
});
```

- [x] **Step 2: Run the new tests and verify the expected RED failure**

Run: `npx vitest run tests/shared/structured-test-helpers.test.ts`

Expected: FAIL because `structured-test-helpers.ts` and the parameterized `createTestNexusOptions` contract do not exist yet.

- [x] **Step 3: Implement the typed shared helpers**

Implement `tests/shared/structured-test-helpers.ts` with these behaviors:

```typescript
export const createStructuredSource = (filePath: string, text: string): StructuredSource => {
  const bytes = Buffer.from(text, 'utf8');
  return { filePath, language: 'typescript', bytes, text: decodeUtf8(bytes) };
};

export const createStructuredCoordinatorFixture = async (
  options: { readonly bootstrapStructuredSchema?: boolean } = {},
): Promise<StructuredCoordinatorFixture> => {
  const metadataStore = new InMemoryMetadataStore();
  const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
  await metadataStore.initialize();
  await vectorStore.initialize();
  if (options.bootstrapStructuredSchema) {
    await metadataStore.bootstrapStructuredSchema();
  }

  const pluginRegistry = new PluginRegistry();
  pluginRegistry.registerLanguage(new TypeScriptLanguagePlugin());
  const chunker = new Chunker(pluginRegistry);
  const projectWriteCoordinator = new ProjectWriteCoordinator();
  const coordinator = createStructuredCoordinator({ metadataStore, vectorStore, pluginRegistry });
  return { metadataStore, vectorStore, pluginRegistry, chunker, projectWriteCoordinator, coordinator };
};
```

Use `createGenerationId`, `createSymbolId`, and `sha256Hex` in `createStructuredStage`; keep the existing `function`/`typescript` fixture defaults and allow byte-range overrides needed by the lifecycle tests.

- [x] **Step 4: Extend the existing options factory without changing defaults**

Add an optional config object to `tests/shared/create-test-nexus-options.ts`:

```typescript
export interface TestNexusOptionsConfig {
  readonly projectRoot?: string;
  readonly fileContent?: string;
  readonly chunkContent?: string;
  readonly bootstrapStructuredSchema?: boolean;
  readonly metricsHooks?: MetricsHooks;
}
```

Use the current values as defaults, pass `projectRoot` through the orchestrator, sanitizer, and returned options, return `fileContent` from `loadFileContent`, seed the grep fixture with `fileContent`, seed the vector chunk with `chunkContent`, bootstrap the schema only when requested, and include `metricsHooks` only when supplied.

- [x] **Step 5: Run the helper tests and verify GREEN**

Run: `npx vitest run tests/shared/structured-test-helpers.test.ts`

Expected: PASS with all helper-contract assertions green.

### Task 2: Remove the benchmark security finding

**Files:**
- Modify: `tests/benchmarks/structured-retrieval.bench.ts:1-120`

**Interfaces:**
- Consumes `createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true })` and `createStructuredSource()` from Task 1.
- Produces the same benchmark setup and cleanup, with no `Math.random()` call.

- [x] **Step 1: Replace the temporary directory expression**

Replace the current expression:

```typescript
const projectRoot = path.join(os.tmpdir(), `nexus-structured-bench-${Date.now()}-${Math.random().toString(36).slice(2)}`);
```

with:

```typescript
const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-structured-bench-'));
```

Keep `rm(projectRoot, { recursive: true, force: true })` in the existing `finally` block.

- [x] **Step 2: Replace duplicated benchmark coordinator setup**

Use the shared fixture for the metadata store, vector store, and coordinator, and use `createStructuredSource(file.filePath, file.text)` for the source. Remove imports that become unused; do not change benchmark cases or iteration counts.

- [x] **Step 3: Run the benchmark file and verify it still executes**

Run: `npm run test:bench -- tests/benchmarks/structured-retrieval.bench.ts`

Expected: the benchmark completes without setup or cleanup errors, and the source contains no `Math.random()` call.

### Task 3: Deduplicate structured unit-test fixtures

**Files:**
- Modify: `tests/unit/structured/structured-index-coordinator.test.ts`
- Modify: `tests/unit/structured/full-rebuild-lifecycle.test.ts`
- Modify: `tests/unit/structured/retrieval-service.test.ts`

**Interfaces:**
- Consumes the shared source, coordinator, stage, and lifecycle helpers from Task 1.
- Preserves all existing test names, assertions, byte ranges, failure injection, and schema-state expectations.

- [x] **Step 1: Replace duplicated source and coordinator setup**

Use `createStructuredSource`, `createStructuredCoordinatorFixture`, and `createStructuredCoordinator` instead of local `makeSource` functions and repeated store/plugin/coordinator initialization. Pass `{ bootstrapStructuredSchema: true }` only to `retrieval-service.test.ts`; leave the lifecycle tests in the legacy schema state by default.

- [x] **Step 2: Replace duplicated stage builders**

Use `createStructuredStage` and `stageStructuredFile` in `structured-index-coordinator.test.ts`; use `createStructuredStage` and `runStructuredFullRebuild` in `full-rebuild-lifecycle.test.ts`. Preserve the full-rebuild test's explicit `startByte: 0` and `endByte: 30`.

- [x] **Step 3: Collapse repeated import fixtures in the retrieval tests**

Create one local `makeImportFixture()` and one local `runImportFixture()` for the two tests that index the same UTF-8 import and symbol. Keep the changed-file assertion in the hash-mismatch test and the current-file assertion in the raw-source test separate.

- [x] **Step 4: Run the affected unit tests**

Run: `npx vitest run tests/unit/structured/structured-index-coordinator.test.ts tests/unit/structured/full-rebuild-lifecycle.test.ts tests/unit/structured/retrieval-service.test.ts`

Expected: PASS with all existing structured unit assertions green.

### Task 4: Reuse shared options in the HTTP integration test

**Files:**
- Modify: `tests/integration/structured-retrieval.test.ts`

**Interfaces:**
- Consumes the parameterized `createTestNexusOptions`, `createStructuredSource`, and `createStructuredCoordinator` helpers.
- Produces the same MCP tool catalog, source, context, error, metrics, and index-status assertions.

- [x] **Step 1: Replace repeated runtime dependency construction**

Call `createTestNexusOptions({ projectRoot, fileContent: chunkText, chunkContent: chunkText, bootstrapStructuredSchema: true, metricsHooks: mockMetricsHooks })`, then pass the returned `options` directly to `createNexusServer`. Use the returned in-memory stores and `createStructuredCoordinator` to stage and activate the structured record.

- [x] **Step 2: Use `mkdtemp()` for the integration project root**

Replace the `Date.now()` plus `Math.random()` path with `mkdtemp(path.join(os.tmpdir(), 'nexus-structured-retrieval-'))`; retain the existing `afterEach` recursive cleanup.

- [x] **Step 3: Run the integration test**

Run: `npx vitest run tests/integration/structured-retrieval.test.ts`

Expected: PASS with all MCP and metrics assertions unchanged.

### Task 5: Run the complete quality gates

**Files:**
- Verify: `tests/benchmarks/structured-retrieval.bench.ts`
- Verify: `tests/shared/structured-test-helpers.ts`
- Verify: `tests/shared/create-test-nexus-options.ts`
- Verify: structured unit and integration test files from Tasks 2-4

- [x] **Step 1: Run the full Vitest suite**

Run: `npx vitest run`

Expected: all tests pass.

- [x] **Step 2: Run lint and type checking**

Run: `npm run lint`

Run: `npx tsc --noEmit`

Expected: both commands exit successfully without new diagnostics.

- [x] **Step 3: Run the workspace build**

Run: `npm run build`

Expected: the root package and dashboard build successfully.

- [x] **Step 4: Confirm the Sonar-specific source conditions**

Check that `tests/benchmarks/structured-retrieval.bench.ts` contains no `Math.random()` call and that the repeated local setup blocks have been replaced by shared helper calls. Report the local verification results; SonarCloud must be re-evaluated by the PR check after the changes are pushed.
