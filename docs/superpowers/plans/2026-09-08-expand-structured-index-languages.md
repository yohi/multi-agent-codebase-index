# Expand Structured Index Language Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the TypeScript-family language plugin so `.mjs`, `.cjs`, `.mts`, and `.cts` files are routed to the existing structured parser, add regression tests that prove `--reindex --full` persists `.mjs` declarations and imports, and document all supported structured-index extensions.

**Architecture:** Add the four module extensions to `TypeScriptLanguagePlugin.fileExtensions` so `LanguagePlugin.supports()` routes the new files to both the legacy/vector parser (`TypeScriptParser`) and the structured parser (`TypeScriptStructuredParser`). Keep CommonJS `require()` extraction out of scope. Add only fixtures and deterministic regression tests; do not introduce new plugins, configuration flags, or public APIs.

**Tech Stack:** TypeScript 5.9, Node.js >=24, Vitest, `typescript` compiler API, Nexus structured-index pipeline.

## Global Constraints

- Keep `.ts`, `.tsx`, `.js`, `.jsx` behavior unchanged.
- Route `.mjs`, `.cjs`, `.mts`, and `.cts` to the existing `TypeScriptStructuredParser` only by changing `fileExtensions`.
- Do not extract `require()`-based imports or assignment-style CommonJS exports as structured declarations/imports in Phase 1.
- Do not add production interfaces or public APIs solely for test observation.
- Do not add new language plugins, parser frameworks, or dependencies.
- Unsupported extensions still receive only fixed-line vector chunks; no new generic routing abstraction.
- Tests run with `npx vitest run <file>`.
- Type check with `npx tsc --noEmit`.
- Lint with `npm run lint`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `tests/unit/storage/in-memory-metadata-store.ts` | Test-only helper `getActiveImportsForFile` for inspection of active generation imports. |
| `tests/unit/storage/metadata-store.test.ts` | Regression test for the test-only helper. |
| `tests/unit/structured/typescript-parser.test.ts` | Regression: module-variant fixtures parse without diagnostics and produce expected declarations/imports. |
| `tests/fixtures/structured/typescript/valid.mjs` | Fixture: ESM JavaScript declaration + ES `import`. |
| `tests/fixtures/structured/typescript/valid.mts` | Fixture: ESM TypeScript declaration + ES `import`. |
| `tests/fixtures/structured/typescript/valid.cjs` | Fixture: CommonJS JavaScript declaration; assignment-style export is not extracted. |
| `tests/fixtures/structured/typescript/valid.cts` | Fixture: CommonJS TypeScript declaration; `export =` is not extracted. |
| `src/plugins/languages/typescript.ts` | Production change: extend `fileExtensions` with the four module variants. |
| `tests/unit/plugins/languages/typescript.test.ts` | Regression: plugin `supports()` returns true for all TS/JS extensions and false for unrelated extensions. |
| `tests/unit/indexer/pipeline-structured-lifecycle.test.ts` | Regression: full rebuild persists `.mjs` declaration and ES import into active structured generation. |
| `tests/unit/indexer/chunker.test.ts` | Regression: `.mjs` file produces declaration-based vector chunks via the TypeScript plugin. |
| `docs/structured-index.md` | New documentation: supported languages/extensions, structured vs vector distinction, CommonJS limitation note, request-language instructions. |

---

### Task 1: Add Test-Only Active-Import Helper

**Files:**
- Modify: `tests/unit/storage/in-memory-metadata-store.ts`
- Test: `tests/unit/storage/metadata-store.test.ts`

**Interfaces:**
- Consumes: private `active` map of `StructuredGenerationStage` keyed by `filePath`.
- Produces: `getActiveImportsForFile(filePath: string): readonly StructuredImport[]` method on `InMemoryMetadataStore`.

- [ ] **Step 1: Write the failing test**

Open `tests/unit/storage/metadata-store.test.ts` and append the following test.
The test imports `InMemoryMetadataStore` from the local helper file, not from
`src/storage/metadata-store.js`:

```typescript
import { InMemoryMetadataStore } from './in-memory-metadata-store.js';
import type { StructuredImport } from '../../../src/structured/contracts.js';

it('exposes active generation imports through the test-only helper', async () => {
  const store = new InMemoryMetadataStore();
  await store.initialize();
  await store.bootstrapStructuredSchema();
  await store.incrementRebuildEpoch();
  const generationId = 'test-generation';
  const importRecord: StructuredImport = {
    id: 'import-1',
    moduleSpecifier: './dependency.js',
    bindingName: 'dependency',
    startByte: 0,
    endByte: 1,
    sourceHash: 'hash',
    completeness: 'complete',
    position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
  };
  await store.stageGeneration({
    filePath: 'src/example.mjs',
    generation: {
      generationId,
      schemaVersion: 1,
      parserId: 'typescript',
      parserVersion: '5.9.3',
      fileHash: 'hash',
      fileCompleteness: 'complete',
    },
    declarations: [],
    imports: [importRecord],
    rebuildEpoch: 1,
    bytes: new Uint8Array([0]),
    fileHash: 'hash',
    fileCompleteness: 'complete',
  });
  await store.activateGeneration({
    filePath: 'src/example.mjs',
    generationId,
    expectedActiveGeneration: null,
    expectedRebuildEpoch: 1,
  });

  expect(store.getActiveImportsForFile('src/example.mjs')).toEqual([
    expect.objectContaining({ moduleSpecifier: './dependency.js', bindingName: 'dependency' }),
  ]);
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run tests/unit/storage/metadata-store.test.ts -t "exposes active generation imports"`

Expected: FAIL with `getActiveImportsForFile is not a function`.

- [ ] **Step 3: Add the helper method**

In `tests/unit/storage/in-memory-metadata-store.ts`, add the following import if
it is not already present:

```typescript
import type { StructuredImport } from '../../../src/structured/contracts.js';
```

Then add the method after `getFileDeclarations`:

```typescript
getActiveImportsForFile(filePath: string): readonly StructuredImport[] {
  const active = this.active.get(filePath);
  if (active === undefined) return [];
  return active.imports;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/storage/metadata-store.test.ts -t "exposes active generation imports"`

Expected: PASS.

- [ ] **Step 5: Run typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add tests/unit/storage/in-memory-metadata-store.ts tests/unit/storage/metadata-store.test.ts
GIT_MASTER=1 git commit -m "test(structured-index): active generation の imports を覗き見るテスト用ヘルパーを追加"
```

---

### Task 2: Add Structured Parser Fixtures for Module Variants

**Files:**
- Create: `tests/fixtures/structured/typescript/valid.mjs`
- Create: `tests/fixtures/structured/typescript/valid.mts`
- Create: `tests/fixtures/structured/typescript/valid.cjs`
- Create: `tests/fixtures/structured/typescript/valid.cts`
- Test: `tests/unit/structured/typescript-parser.test.ts`

**Interfaces:**
- Consumes: `TypeScriptLanguagePlugin.createStructuredParser()`, `parseStructured({ filePath, language, bytes, text })` returning `StructuredParseResult`.
- Produces: fixtures exist with valid module declarations and, for ESM variants, one ES `import`.

- [ ] **Step 1: Write the failing parser tests**

Append to `tests/unit/structured/typescript-parser.test.ts`:

```typescript
it.each([
  ['valid.mjs', 'rebuilt', true],
  ['valid.mts', 'rebuilt', true],
  ['valid.cjs', 'helper', false],
  ['valid.cts', 'helper', false],
] as const)(
  'parses %s with status ok and retrievability exact',
  async (name, expectedDeclaration, expectsImport) => {
    const { result } = await parseFixture(name);

    expect(result.status).toBe('ok');
    expect(result.retrievability).toBe('exact');
    expect(
      result.declarations.some((item) => item.qualifiedName === expectedDeclaration),
    ).toBe(true);

    if (expectsImport) {
      expect(result.imports).toContainEqual(
        expect.objectContaining({ moduleSpecifier: './dependency.js', bindingName: 'dependency' }),
      );
    }
  },
);
```

- [ ] **Step 2: Run the failing test and confirm fixture absence RED**

Run: `npx vitest run tests/unit/structured/typescript-parser.test.ts -t "parses valid.mjs"`

Expected: FAIL because the fixture files do not exist yet.

- [ ] **Step 3: Create the fixtures**

Create `tests/fixtures/structured/typescript/valid.mjs`:

```javascript
import { dependency } from './dependency.js';

export function rebuilt() {
  return dependency;
}
```

Create `tests/fixtures/structured/typescript/valid.mts`:

```typescript
import { dependency } from './dependency.js';

export function rebuilt(): number {
  return dependency;
}
```

Create `tests/fixtures/structured/typescript/valid.cjs`:

```javascript
function helper() {
  return 1;
}

exports.rebuilt = helper;
```

Create `tests/fixtures/structured/typescript/valid.cts`:

```typescript
function helper(): number {
  return 1;
}

export = { rebuilt: helper };
```

For `.cjs` and `.cts`, the assignment-style exports (`exports.rebuilt = helper`
and `export = { rebuilt: helper }`) are intentionally left in the fixtures to
visualize the known Phase 1 limitation. They must **not** be asserted as
extracted declarations.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/structured/typescript-parser.test.ts -t "parses valid"`

Expected: PASS for all four fixtures.

If any fixture unexpectedly produces syntactic diagnostics, stop implementation
and follow this order:

1. Stop implementation.
2. Update `docs/superpowers/specs/2026-09-08-expand-structured-index-languages-design.md`
   with the exact fixture, the diagnostic reason, and the proposed new
   expected `status` / `retrievability`.
3. Update Task 2 in this plan to match the new expectation.
4. Re-check design → plan and plan → design traceability.
5. Only then resume implementation.

- [ ] **Step 5: Run the relevant parser suite**

Run: `npx vitest run tests/unit/structured/typescript-parser.test.ts`

Expected: PASS.

- [ ] **Step 6: Run typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
GIT_MASTER=1 git add tests/fixtures/structured/typescript/valid.* tests/unit/structured/typescript-parser.test.ts
GIT_MASTER=1 git commit -m "test(structured-index): TypeScript モジュール変種の構造化解析フィクスチャを追加"
```

---

### Task 3: Extend TypeScript-Family Plugin Extensions

**Files:**
- Modify: `src/plugins/languages/typescript.ts`
- Modify: `tests/unit/plugins/languages/typescript.test.ts`
- Modify: `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`
- Modify: `tests/unit/indexer/chunker.test.ts`

**Interfaces:**
- Consumes:
  - existing `LanguagePlugin` contract (`fileExtensions`, `supports(filePath)`),
  - `IndexPipeline.reindex(events, loadContent, true)`,
  - `metadataStore.resolveFile`,
  - `metadataStore.getFileDeclarations`,
  - test-only `metadataStore.getActiveImportsForFile` from Task 1,
  - `PluginRegistry.registerLanguage`,
  - `Chunker.chunkFiles`.
- Produces:
  - `TypeScriptLanguagePlugin.fileExtensions` includes `.mjs`, `.cjs`, `.mts`, `.cts`;
  - regression tests proving `.mjs` routing on the structured and vector paths.

This task applies the single production change (`fileExtensions`) only after
all dependent regression tests have been written and confirmed to fail against
the old extension set.

- [ ] **Step 1: Add the plugin routing regression test**

Append to `tests/unit/plugins/languages/typescript.test.ts`:

```typescript
it('supports TypeScript and JavaScript module variants', () => {
  const plugin = new TypeScriptLanguagePlugin();

  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']) {
    expect(plugin.supports(`src/example${extension}`)).toBe(true);
  }

  for (const extension of ['.rs', '.py', '.go', '.txt', '.md']) {
    expect(plugin.supports(`src/example${extension}`)).toBe(false);
  }
});
```

- [ ] **Step 2: Confirm the routing test is RED before the production change**

Run: `npx vitest run tests/unit/plugins/languages/typescript.test.ts -t "supports TypeScript and JavaScript module variants"`

Expected: FAIL because `.mjs`, `.cjs`, `.mts`, and `.cts` are not yet in
`fileExtensions`.

- [ ] **Step 3: Add the `.mjs` full-reindex integration regression test**

Append to `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`:

```typescript
it('persists .mjs declarations and imports after a structured full rebuild', async () => {
  const { metadataStore, pipeline } = await createStructuredPipeline();
  const filePath = 'src/rebuilt.mjs';
  const content = [
    "import { dependency } from './dependency.js';",
    '',
    'export function rebuilt() {',
    '  return dependency;',
    '}',
  ].join('\n');

  await pipeline.reindex(
    async () => [createEvent('added', filePath, content)],
    async () => content,
    true,
  );

  const resolution = await metadataStore.resolveFile(filePath);
  expect(resolution).toEqual({ kind: 'active', generationId: expect.any(String) });

  const declarations = await metadataStore.getFileDeclarations(filePath);
  expect(declarations).toContainEqual(
    expect.objectContaining({ qualifiedName: 'rebuilt', kind: 'function' }),
  );

  const imports = metadataStore.getActiveImportsForFile(filePath);
  expect(imports).toHaveLength(1);
  expect(imports[0]).toMatchObject({
    moduleSpecifier: './dependency.js',
    bindingName: 'dependency',
  });
});
```

- [ ] **Step 4: Confirm the full-reindex test is RED before the production change**

Run: `npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "persists .mjs declarations and imports"`

Expected: FAIL because `.mjs` is not routed to the TypeScript structured
parser, so the file is not included in the structured full rebuild and no
active generation is created.

- [ ] **Step 5: Add the `.mjs` vector/shared-routing regression test**

Append to `tests/unit/indexer/chunker.test.ts`:

```typescript
it('routes .mjs files through the TypeScript plugin and produces declaration chunks', async () => {
  const registry = new PluginRegistry();
  registry.registerLanguage(new TypeScriptLanguagePlugin());

  const chunker = new Chunker(registry);
  const content = 'export function rebuilt() {\n  return 1;\n}\n';
  const chunks = await chunker.chunkFiles([
    {
      filePath: 'src/rebuilt.mjs',
      language: 'typescript',
      content,
    },
  ]);

  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks).toContainEqual(
    expect.objectContaining({ symbolName: 'rebuilt', symbolKind: 'function' }),
  );
});
```

- [ ] **Step 6: Confirm the vector routing test is RED before the production change**

Run: `npx vitest run tests/unit/indexer/chunker.test.ts -t "routes .mjs files through the TypeScript plugin"`

Expected: FAIL because the chunker cannot find a language plugin for `.mjs`
under the old `fileExtensions`, so it falls back to fixed-line chunking and
produces no declaration-based chunks.

- [ ] **Step 7: Apply the minimal production change**

In `src/plugins/languages/typescript.ts`, change:

```typescript
readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx'];
```

to:

```typescript
readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
```

This is the only production change in Phase 1.

- [ ] **Step 8: Run the targeted regression tests and confirm GREEN**

Run each targeted test:

```bash
npx vitest run tests/unit/plugins/languages/typescript.test.ts -t "supports TypeScript and JavaScript module variants"
npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "persists .mjs declarations and imports"
npx vitest run tests/unit/indexer/chunker.test.ts -t "routes .mjs files through the TypeScript plugin"
```

Expected: all PASS.

- [ ] **Step 9: Run the relevant suites**

```bash
npx vitest run tests/unit/plugins/languages/typescript.test.ts
npx vitest run tests/unit/structured/typescript-parser.test.ts
npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts
npx vitest run tests/unit/indexer/chunker.test.ts
```

Expected: all PASS.

- [ ] **Step 10: Run typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: both pass.

- [ ] **Step 11: Commit**

```bash
GIT_MASTER=1 git add src/plugins/languages/typescript.ts tests/unit/plugins/languages/typescript.test.ts tests/unit/indexer/pipeline-structured-lifecycle.test.ts tests/unit/indexer/chunker.test.ts
GIT_MASTER=1 git commit -m "feat(structured-index): TypeScript プラグインで .mjs/.cjs/.mts/.cts をサポート"
```

---

### Task 4: Document Supported Structured-Index Languages

**Files:**
- Create: `docs/structured-index.md`

**Interfaces:**
- Consumes: acceptance criteria from the design spec; no code interfaces.
- Produces: user-facing documentation listing supported structured-index extensions and explaining unsupported-file behavior.

- [ ] **Step 1: Create the documentation file**

Create `docs/structured-index.md` with the following content:

```markdown
# Structured Index

The structured index stores **declarations** (functions, classes, interfaces,
variables, and so on) and **imports** for supported source files. It is built
alongside the vector index during `--reindex --full` and is used for
symbol-aware retrieval and reasoning.

## Supported languages and extensions

| Language family         | Structured extensions                                  |
| ----------------------- | ------------------------------------------------------ |
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` |
| Python                  | `.py`                                                  |
| Go                      | `.go`                                                  |

A file with a supported extension is routed to the structured parser for that
language family. It still receives vector chunks at the same time. Structured
declarations and imports are produced only when the parser actually extracts
them from the file; not every supported file necessarily contributes
structured records.

## Structured index vs vector index

Files with supported extensions may contribute to both the structured index
and the vector index, depending on whether the structured parser extracts
declarations and imports from them.

Files with unsupported extensions (for example `.rs`, `.md`, `.txt`) are still
indexed, but only as fixed-line **vector chunks**. They do not produce
structured declarations or imports.

## Known limitations

- CommonJS `require()` calls and assignment-style exports such as
  `module.exports`, `exports.foo`, and `export = { ... }` are **not extracted**
  as structured declarations or imports in Phase 1. Only ECMAScript `import`
  and declaration syntax is captured.

## Requesting additional languages

To request support for another language or extension, open an issue that
includes:

1. The language or extension you need.
2. A sample source file that should be parsed.
3. The declarations and imports you expect to be extracted.
```

- [ ] **Step 2: Validate the documentation with the existing repo tool**

Run:

```bash
npx prettier --check docs/structured-index.md
```

Expected: no formatting errors.

- [ ] **Step 3: Commit**

```bash
GIT_MASTER=1 git add docs/structured-index.md
GIT_MASTER=1 git commit -m "docs(structured-index): サポート言語と拡張子、制限事項を記載"
```

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Route `.mjs`/`.cjs`/`.mts`/`.cts` to `TypeScriptStructuredParser` | Task 3 (after RED confirmation) |
| Keep existing `.ts`/`.tsx`/`.js`/`.jsx` behavior | Task 3 Step 9 post-change suites |
| Add plugin routing regression tests | Task 3 |
| Add structured parser regression tests + fixtures | Task 2 |
| Add `.mjs` full-reindex integration regression | Task 3 |
| Add test-only `getActiveImportsForFile` helper | Task 1 |
| Add `.mjs` vector/shared-routing regression | Task 3 |
| Document supported extensions and unsupported distinction | Task 4 |
| No new plugins, frameworks, or dependencies | Tasks 1-4 |
| `.cjs`/`.cts` assignment-style exports are not extracted | Task 2 (fixture expectations) |

**2. Placeholder scan:**

- No `TODO`, `TBD`, `implement later`, or `fill in details`.
- No vague `add appropriate error handling` or `write tests for the above`.
- No `Similar to Task N` references.
- Every code step includes concrete file content and run commands.
- No `or`, `適宜`, `if needed`, `unless`, or `adjust as needed` instructions
  that delegate design decisions to the implementer.

**3. Type consistency:**

- `getActiveImportsForFile(filePath: string): readonly StructuredImport[]` matches the design spec signature.
- `TypeScriptLanguagePlugin.fileExtensions` is updated in one place.
- Test assertions use `qualifiedName`, `kind`, `moduleSpecifier`, `bindingName` consistently with existing tests and the `StructuredImport` contract.

**4. RED-GREEN order:**

- Task 1 helper: test is written first and fails before the helper is added.
- Task 2 fixtures: parser test is written first and fails because fixtures are missing, then fixtures are added.
- Task 3 production change: routing, full-reindex, and chunker tests are all written and confirmed RED before `fileExtensions` is changed; GREEN is confirmed after the change.
- No source change precedes the tests that justify it.

**5. Traceability:**

- Each plan task maps to one or more design spec requirements.
- The design spec's expected fixture status (`ok`/`exact`) matches the plan's assertions.
- The design spec's CommonJS non-goals match the plan's fixture expectations and documentation text.
