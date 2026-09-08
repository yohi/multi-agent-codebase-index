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
- Tests run with `npx vitest run <file>` and the full suite runs with `npx vitest run`.
- Type check with `npx tsc --noEmit`.
- Lint with `npm run lint`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/plugins/languages/typescript.ts` | Production change: extend `fileExtensions` with the four module variants. |
| `docs/structured-index.md` | New documentation: supported languages/extensions, structured vs vector distinction, CommonJS limitation note, request-language instructions. |
| `tests/unit/plugins/languages/typescript.test.ts` | Regression: plugin `supports()` returns true for all TS/JS extensions and false for unrelated extensions. |
| `tests/unit/structured/typescript-parser.test.ts` | Regression: module-variant fixtures parse without diagnostics and produce expected declarations/imports. |
| `tests/fixtures/structured/typescript/valid.mjs` | Fixture: ESM JavaScript declaration + ES `import`. |
| `tests/fixtures/structured/typescript/valid.mts` | Fixture: ESM TypeScript declaration + ES `import`. |
| `tests/fixtures/structured/typescript/valid.cjs` | Fixture: CommonJS JavaScript declaration; no `require()` import assertion. |
| `tests/fixtures/structured/typescript/valid.cts` | Fixture: CommonJS TypeScript declaration; no `require()` import assertion. |
| `tests/unit/indexer/pipeline-structured-lifecycle.test.ts` | Regression: full rebuild persists `.mjs` declaration and ES import into active structured generation. |
| `tests/unit/storage/in-memory-metadata-store.ts` | Test-only helper `getActiveImportsForFile` for inspection of active generation imports. |
| `tests/unit/indexer/chunker.test.ts` | Regression: `.mjs` file produces declaration-based vector chunks via the TypeScript plugin. |

---

### Task 1: Extend TypeScript-Family Plugin Extensions

**Files:**
- Modify: `src/plugins/languages/typescript.ts`
- Test: `tests/unit/plugins/languages/typescript.test.ts`

**Interfaces:**
- Consumes: existing `LanguagePlugin` contract (`fileExtensions`, `supports(filePath)`).
- Produces: `TypeScriptLanguagePlugin.fileExtensions` includes `.mjs`, `.cjs`, `.mts`, `.cts`.

- [ ] **Step 1: Write the failing test**

Add a new test at the end of `tests/unit/plugins/languages/typescript.test.ts`:

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

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run tests/unit/plugins/languages/typescript.test.ts -t "supports TypeScript and JavaScript module variants"`

Expected: FAIL because `.mjs`, `.cjs`, `.mts`, `.cts` are not in `fileExtensions`.

- [ ] **Step 3: Make the minimal production change**

In `src/plugins/languages/typescript.ts`, change:

```typescript
readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx'];
```

to:

```typescript
readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/plugins/languages/typescript.test.ts`

Expected: PASS (all existing tests plus the new extension routing test).

- [ ] **Step 5: Run typecheck and lint**

Run:

```bash
npx tsc --noEmit
npm run lint
```

Expected: both pass with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/plugins/languages/typescript.ts tests/unit/plugins/languages/typescript.test.ts
git commit -m "feat(structured-index): TypeScript プラグインで .mjs/.cjs/.mts/.cts をサポート"
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

- [ ] **Step 1: Write the four fixtures**

`tests/fixtures/structured/typescript/valid.mjs`:

```javascript
import { dependency } from './dependency.js';

export function rebuilt() {
  return dependency;
}
```

`tests/fixtures/structured/typescript/valid.mts`:

```typescript
import { dependency } from './dependency.js';

export function rebuilt(): number {
  return dependency;
}
```

`tests/fixtures/structured/typescript/valid.cjs`:

```javascript
function helper() {
  return 1;
}

exports.rebuilt = helper;
```

`tests/fixtures/structured/typescript/valid.cts`:

```typescript
function helper(): number {
  return 1;
}

export = { rebuilt: helper };
```

- [ ] **Step 2: Write the failing test**

Append to `tests/unit/structured/typescript-parser.test.ts`:

```typescript
it.each([
  ['valid.mjs', true],
  ['valid.mts', true],
  ['valid.cjs', false],
  ['valid.cts', false],
] as const)('parses %s with status ok and retrievability exact', async (name, expectsImport) => {
  const { result } = await parseFixture(name);

  expect(result.status).toBe('ok');
  expect(result.retrievability).toBe('exact');
  expect(result.declarations.some((item) => item.qualifiedName === 'rebuilt')).toBe(true);

  if (expectsImport) {
    expect(result.imports).toContainEqual(
      expect.objectContaining({ moduleSpecifier: './dependency.js', bindingName: 'dependency' }),
    );
  }
});
```

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run tests/unit/structured/typescript-parser.test.ts -t "parses valid.mjs"`

Expected: FAIL because fixtures do not exist yet.

- [ ] **Step 4: Create the fixtures (Step 1 contents) and verify the test passes**

Run: `npx vitest run tests/unit/structured/typescript-parser.test.ts`

Expected: PASS, unless TypeScript reports syntactic diagnostics for `.cjs`/`.cts` fixtures. If `valid.cts` produces `export =` diagnostics that degrade the status, document the fixture and expected status here before implementation and adjust the test for that case only. **Do not** broaden the ESM expectations.

- [ ] **Step 5: Run typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/structured/typescript/valid.* tests/unit/structured/typescript-parser.test.ts
git commit -m "test(structured-index): TypeScript モジュール変種の構造化解析フィクスチャを追加"
```

---

### Task 3: Add Test-Only Active-Import Helper

**Files:**
- Modify: `tests/unit/storage/in-memory-metadata-store.ts`
- Test: `tests/unit/storage/in-memory-metadata-store.test.ts` (use an existing test or add a minimal inline assertion in `pipeline-structured-lifecycle.test.ts` in Task 4).

**Interfaces:**
- Consumes: private `active` map of `StructuredGenerationStage` keyed by `filePath`.
- Produces: `getActiveImportsForFile(filePath: string): readonly StructuredImport[]` method on `InMemoryMetadataStore`.

- [ ] **Step 1: Write the failing test in the store test file**

Open `tests/unit/storage/metadata-store.test.ts` (or create a focused inline assertion). Add:

```typescript
it('exposes active generation imports through the test-only helper', async () => {
  const store = new InMemoryMetadataStore();
  await store.initialize();
  await store.bootstrapStructuredSchema();
  await store.incrementRebuildEpoch();
  const generationId = 'test-generation';
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
    imports: [{ id: 'import-1', moduleSpecifier: './dependency.js', bindingName: 'dependency', startByte: 0, endByte: 1, sourceHash: 'hash', completeness: 'complete', position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 } }],
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

In `tests/unit/storage/in-memory-metadata-store.ts`, add after `getFileDeclarations`:

```typescript
getActiveImportsForFile(filePath: string): readonly StructuredImport[] {
  const active = this.active.get(filePath);
  if (active === undefined) return [];
  return active.imports;
}
```

Ensure `StructuredImport` is imported from `../../../src/structured/contracts.js`.

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
git add tests/unit/storage/in-memory-metadata-store.ts tests/unit/storage/metadata-store.test.ts
git commit -m "test(structured-index): active generation の imports を覗き見るテスト用ヘルパーを追加"
```

---

### Task 4: Add `.mjs` Full-Reindex Integration Regression

**Files:**
- Modify: `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`

**Interfaces:**
- Consumes: `IndexPipeline.reindex(events, loadContent, true)`, `metadataStore.resolveFile`, `metadataStore.getFileDeclarations`, test-only `metadataStore.getActiveImportsForFile`.
- Produces: a test proving `.mjs` declaration and ES import persist in the active structured generation after full rebuild.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`:

```typescript
it('persists .mjs declarations and imports after a structured full rebuild', async () => {
  const { metadataStore, pipeline, coordinator } = await createStructuredPipeline();
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

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "persists .mjs declarations and imports"`

Expected: FAIL because `.mjs` is not yet routed to the TypeScript plugin if Task 1 is not applied; after Task 1 it should PASS.

- [ ] **Step 3: Ensure the dependency is applied and run the test**

Verify Task 1 is merged. Run:

```bash
npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -t "persists .mjs declarations and imports"
```

Expected: PASS.

- [ ] **Step 4: Run typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/indexer/pipeline-structured-lifecycle.test.ts
git commit -m "test(structured-index): .mjs の完全再索引で宣言と import が永続化することを検証"
```

---

### Task 5: Add `.mjs` Vector/Shared-Routing Regression

**Files:**
- Modify: `tests/unit/indexer/chunker.test.ts`

**Interfaces:**
- Consumes: `PluginRegistry.registerLanguage`, `Chunker.chunkFiles`, `TypeScriptLanguagePlugin`.
- Produces: assertion that a `.mjs` file yields a declaration-based chunk with `symbolName: 'rebuilt'` and `symbolKind: 'function'`.

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run tests/unit/indexer/chunker.test.ts -t "routes .mjs files through the TypeScript plugin"`

Expected: FAIL before Task 1; PASS after Task 1.

- [ ] **Step 3: Verify with Task 1 applied**

Run: `npx vitest run tests/unit/indexer/chunker.test.ts`

Expected: PASS.

- [ ] **Step 4: Run typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/indexer/chunker.test.ts
git commit -m "test(chunker): .mjs ファイルが TypeScript プラグイン経由で declaration チャンクを生成することを検証"
```

---

### Task 6: Document Supported Structured-Index Languages

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

## Structured index vs vector index

Files with supported extensions are parsed for declarations and imports and
contribute to **both** the structured index and the vector index.

Files with unsupported extensions (for example `.rs`, `.md`, `.txt`) are still
indexed, but only as fixed-line **vector chunks**. They do not produce
structured declarations or imports.

## Known limitations

- CommonJS `require()` calls and assignment-style exports such as
  `module.exports` or `exports.foo` are **not extracted** as structured
  declarations or imports in Phase 1. Only ECMAScript `import` and
  declaration syntax is captured.

## Requesting additional languages

To request support for another language or extension, open an issue that
includes:

1. The language or extension you need.
2. A sample source file that should be parsed.
3. The declarations and imports you expect to be extracted.
```

- [ ] **Step 2: Verify the file renders as Markdown**

Run:

```bash
npx markdownlint-cli2 docs/structured-index.md
```

If `markdownlint-cli2` is not installed locally, install it with:

```bash
npm install -g markdownlint-cli2
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add docs/structured-index.md
git commit -m "docs(structured-index): サポート言語と拡張子、制限事項を記載"
```

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Route `.mjs`/`.cjs`/`.mts`/`.cts` to `TypeScriptStructuredParser` | Task 1 |
| Keep existing `.ts`/`.tsx`/`.js`/`.jsx` behavior | Tasks 1, 2, 5, full suite |
| Add plugin routing regression tests | Task 1 |
| Add structured parser regression tests + fixtures | Task 2 |
| Add `.mjs` full-reindex integration regression | Task 4 |
| Add test-only `getActiveImportsForFile` helper | Task 3 |
| Add `.mjs` vector/shared-routing regression | Task 5 |
| Document supported extensions and unsupported distinction | Task 6 |
| No new plugins, frameworks, or dependencies | Tasks 1-6 |

**2. Placeholder scan:**

- No `TODO`, `TBD`, `implement later`, or `fill in details`.
- No vague `add appropriate error handling` or `write tests for the above`.
- No `Similar to Task N` references.
- Every code step includes concrete file content and run commands.

**3. Type consistency:**

- `getActiveImportsForFile(filePath: string): readonly StructuredImport[]` matches the design spec signature.
- `TypeScriptLanguagePlugin.fileExtensions` is updated in one place.
- Test assertions use `qualifiedName`, `kind`, `moduleSpecifier`, `bindingName` consistently with existing tests and the `StructuredImport` contract.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-08-expand-structured-index-languages.md`.**

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**
