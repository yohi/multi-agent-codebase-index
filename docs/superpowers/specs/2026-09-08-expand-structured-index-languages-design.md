# Expand Structured Index Language Coverage

## Status

Design — pending implementation plan.

## Context

Issue #287 reports that `--reindex --full` builds both a vector index and a
structured index (symbols / imports) for supported languages. Today the
TypeScript-family plugin only claims `.ts`, `.tsx`, `.js`, and `.jsx`, so
projects that use `.mjs` as their primary source form get zero symbols and
zero imports even though vector chunks are created.

The same `LanguagePlugin.supports(filePath)` boundary is used by both the
legacy/vector chunking path and the structured indexing path. Extending the
TypeScript-family plugin's `fileExtensions` therefore affects both paths.

## Goal

Increase the set of source files that contribute to the structured index by
extending the TypeScript-family plugin to handle JavaScript/TypeScript module
variants (`.mjs`, `.cjs`, `.mts`, `.cts`).

- Route the four new extensions to the existing `TypeScriptStructuredParser`.
- Document the supported languages and extensions.
- Add regression tests that guarantee `--reindex --full` persists `.mjs`
  declarations and imports into the structured index.
- Keep existing `.ts` / `.tsx` / `.js` / `.jsx` behavior unchanged.

## Non-Goals

- Replacing the existing TypeScript, Go, or Python plugins.
- Adding every possible language in a single change.
- Changing how unsupported files are handled at the vector-index level
  (they still receive fixed-line chunks).
- Introducing a new routing abstraction, configuration flag, or generic
  routing policy framework to separate vector and structured routing.

## Phase 1: Extend TypeScript-Family File Extensions

### Why These Extensions

| Extension | Format                                |
| --------- | ------------------------------------- |
| `.mjs`    | ECMAScript module (JavaScript)        |
| `.cjs`    | CommonJS module (JavaScript)          |
| `.mts`    | ECMAScript module (TypeScript)        |
| `.cts`    | CommonJS module (TypeScript)          |

All four are variants of JavaScript/TypeScript syntax and are already parsed
by the TypeScript compiler when `allowJs: true` and `module: NodeNext` are set.
Therefore the existing `TypeScriptStructuredParser` can handle them without
structural changes.

### Architecture / Data Flow

`LanguagePlugin.supports(filePath)` is the shared boundary used by both the
legacy/vector chunking path and the structured indexing path:

1. `Chunker.chunkFiles()` calls `pluginRegistry.getLanguagePlugin(filePath)`
   and, when a plugin is found, invokes `plugin.createParser()`.
2. The structured pipeline also relies on the same `supports()` check to route
   files to `TypeScriptStructuredParser`.

Adding `.mjs`, `.cjs`, `.mts`, and `.cts` to `TypeScriptLanguagePlugin.fileExtensions`
therefore makes those files reachable by the TypeScript plugin in **both** paths.

For the vector path this means:

- Files with a valid declaration will be chunked using the existing TypeScript
  declaration-based chunking logic.
- Files without a declaration, or files where the parser fails, fall back to the
  existing fixed-line chunking logic already used by the chunker.
- The vector index itself continues to be produced. No extensions are removed
  from vector indexing.

This behavior change is accepted as an intentional consequence of the extension
support change in Phase 1.

### Change List

#### Production

1. `src/plugins/languages/typescript.ts`
   - Update `fileExtensions` from `['.ts', '.tsx', '.js', '.jsx']` to
     `['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']`.

#### Documentation update

1. `docs/structured-index.md`
   - Create a "Supported languages and extensions" table.
   - Describe the structured/vector distinction for unsupported extensions.
   - Document CommonJS limitations for Phase 1.

#### Plugin routing test

1. `tests/unit/plugins/languages/typescript.test.ts`
   - Add extension routing regression cases for `.mjs`, `.cjs`, `.mts`, `.cts`
     and existing extensions.

#### Structured parser test

1. `tests/unit/structured/typescript-parser.test.ts`
   - Add module-variant parser regression cases using the four new fixtures.

2. `tests/fixtures/structured/typescript/valid.mjs`
   - New fixture: valid ESM JavaScript declaration with an ES `import`.

3. `tests/fixtures/structured/typescript/valid.mts`
   - New fixture: valid ESM TypeScript declaration with an ES `import`.

4. `tests/fixtures/structured/typescript/valid.cjs`
   - New fixture: valid CommonJS JavaScript declaration.
   - Does not assert `require()` based structured import extraction.

5. `tests/fixtures/structured/typescript/valid.cts`
   - New fixture: valid CommonJS TypeScript declaration.
   - Does not assert `require()` based structured import extraction.

#### Full-reindex integration regression

1. `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`
   - Add `.mjs` full-reindex integration regression verifying declaration and
     import persistence after `pipeline.reindex(..., true)`.

#### Vector/shared-routing regression

1. `tests/unit/indexer/chunker.test.ts`
   - Add `.mjs` regression case verifying the TypeScript plugin is selected on
     the legacy/vector path, vector chunks are still produced, and
     declaration-based chunks contain the expected symbol when a declaration
     is present.
   - Files without a declaration continue to use the fixed-line fallback
     already provided by the chunker.
   - Do not duplicate the existing unsupported-language or parser-failure
     fallback tests.

#### Test support

1. `tests/unit/storage/in-memory-metadata-store.ts`
   - Add the test-only helper:
     `getActiveImportsForFile(filePath: string): readonly StructuredImport[]`
   - Helper is used only by the full-reindex integration test to inspect the
     active generation's `imports` array; it is not part of any production
     interface.

### Test Strategy

Testing is split into four layers covering the main structured indexing paths,
the vector/shared-routing regression, and a test-only storage inspection helper.
Each item has a single, concrete target test file and deterministic expectations.

#### A. Plugin routing test

Target file: `tests/unit/plugins/languages/typescript.test.ts`

Add cases for each new extension and for existing extensions:

- `.mjs`, `.cjs`, `.mts`, `.cts` → `plugin.supports(filePath) === true`
- `.ts`, `.tsx`, `.js`, `.jsx` → `plugin.supports(filePath) === true`
- unsupported extensions (e.g. `.rs`, `.py`, `.go`) →
  `plugin.supports(filePath) === false`

#### B. Structured parser test

Target file: `tests/unit/structured/typescript-parser.test.ts`

Add module-variant fixtures under `tests/fixtures/structured/typescript/`:

- `valid.mjs` — valid ESM declaration plus `import` statement.
  - Expected `status: 'ok'`, `retrievability: 'exact'`.
  - Expected at least one declaration and at least one structured import.
- `valid.mts` — valid ESM TypeScript declaration plus `import` statement.
  - Expected `status: 'ok'`, `retrievability: 'exact'`.
  - Expected at least one declaration and at least one structured import.
- `valid.cjs` — valid CommonJS declaration.
  - Expected `status: 'ok'`, `retrievability: 'exact'`.
  - Expected at least one declaration.
  - `require()` based imports are **not** extracted as structured imports in
    Phase 1; the fixture must not assert structured import extraction for
    `require()`.
- `valid.cts` — valid CommonJS TypeScript declaration.
  - Expected `status: 'ok'`, `retrievability: 'exact'`.
  - Expected at least one declaration.
  - Same `require()` limitation as `.cjs`.

If any fixture unexpectedly produces syntactic diagnostics, do not broaden the
expectation to `ok | degraded`. Instead, document the extension, the minimal
fixture, the diagnostic reason, and the expected status in this design before
implementation.

#### C. Full-reindex integration regression

Target file: `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`

Add a `.mjs` test case that exercises the full pipeline:

1. Create a `.mjs` source file with the exact content:

   ```js
   import { dependency } from './dependency.js';

   export function rebuilt() {
     return dependency;
   }
   ```

2. Call `pipeline.reindex(..., true)` to trigger a clean full rebuild.
3. Verify the `.mjs` file is included in the structured full-rebuild input.
4. Verify the resulting structured work contains the expected declaration (`rebuilt`)
   and one ES `import`.
5. Verify the file has an active structured generation after the rebuild
   completes.
6. Verify the declaration is retrievable from the active structured metadata
   (`resolveFile(filePath)` returns active and `getFileDeclarations(filePath)`
   contains a declaration whose `qualifiedName` includes `rebuilt`).
7. Verify the ES `import` is persisted in the active generation by using the
   test-only inspection helper added to `InMemoryMetadataStore`. Do not add a
   production API or extend `IStructuredCatalog` solely for test observation.

The helper is fixed as:

```ts
getActiveImportsForFile(filePath: string): readonly StructuredImport[]
```

Implementation notes for the helper:

- It lives only in `tests/unit/storage/in-memory-metadata-store.ts`.
- It is **not** part of `IStructuredCatalog` or any other production interface.
- It reads the active `StructuredGenerationStage` for the given file path and
  returns its `imports` array directly.
- After the full rebuild the test asserts:

  - `resolveFile(filePath)` returns `{ kind: 'active', generationId }`.
  - `getFileDeclarations(filePath)` contains the `rebuilt` declaration.
  - `getActiveImportsForFile(filePath)` contains exactly one ES import whose
    `moduleSpecifier` is `'./dependency.js'` and whose `bindingName` is
    `'dependency'`. (These are fixture-level expectations; the parser may still
    produce other fields such as `startByte`, but this integration test does not
    assert them.)

This test directly validates Issue #287's acceptance condition: after
`--reindex --full`, `.mjs` declarations and imports are present in the
structured index.

#### D. Vector/shared-routing regression

Target file: `tests/unit/indexer/chunker.test.ts`

Add a `.mjs` regression case with a valid function declaration:

1. Register `TypeScriptLanguagePlugin` in a `PluginRegistry`.
2. Pass a file whose path ends in `.mjs` (for example `src/rebuilt.mjs`) and
   whose source contains one valid function declaration, such as:

   ```js
   export function rebuilt() {
     return 1;
   }
   ```

3. Call `chunker.chunkFiles(...)`.
4. Assert the result is non-empty.
5. Assert the returned chunks contain a declaration-based chunk whose
   `symbolName` is `rebuilt` and whose `symbolKind` is `function`.

This test is scoped strictly to verifying that `.mjs` files continue to be
indexed on the vector path after `TypeScriptLanguagePlugin.fileExtensions` is
extended. It does not add fallback regression coverage because the existing
chunker tests already cover unsupported-language and parser-failure fallbacks.
It also does not require new production hooks or spies to confirm parser
selection; the presence of a declaration-based chunk with the expected symbol
is sufficient evidence that the TypeScript plugin routed and parsed the file.

### Risks and Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| `.cjs` / `.cts` use | Document in `docs/structured-index.md` and in |
| `require` / `module.exports`, | test fixtures that `require()` based imports |
| which are outside TypeScript's | and assignment-style CommonJS exports |
| import syntax. | (`module.exports`, `exports.foo`) are not |
| | extracted as structured declarations or |
| | imports in Phase 1. |
| `.mjs` / `.mts` may produce | Valid fixtures must expect `status: 'ok'` / |
| syntactic parse diagnostics | `retrievability: 'exact'`. If a syntactic |
| and fall back to | diagnostic is unavoidable, document the exact |
| `fileCompleteness: 'partial'` / | fixture, reason, and expected |
| `retrievability: 'partial'`. | `status: 'degraded'` / |
| Unresolved modules are handled | `retrievability: 'partial'` in this design |
| at the import level and do not | before implementation. |
| alone degrade the file-level | |
| status. | |
| Existing `.ts` / `.tsx` / | Run the full TypeScript plugin test suite, |
| `.js` / `.jsx` behavior may | structured parser tests, and pipeline |
| regress. | lifecycle tests after the change. |
| Adding the four extensions to | Add a `.mjs` regression case to |
| `fileExtensions` may change | `tests/unit/indexer/chunker.test.ts` (see |
| vector chunking behavior for | Test Strategy section D). The case asserts |
| `.mjs` files that previously | the TypeScript plugin is selected on the |
| received fixed-line chunks. | legacy/vector path, vector chunks are still |
| | produced, and declaration-based chunks contain |
| | the expected symbol when a declaration is |
| | present. Files without a declaration |
| | continue to use the fixed-line fallback |
| | already provided by the chunker. |

## Documentation

Create `docs/structured-index.md` containing:

- What the structured index is.
- The "Supported languages and extensions" table:

  | Language family         | Structured extensions            |
  | ----------------------- | -------------------------------- |
  | TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`,    |
  |                         | `.mjs`, `.cjs`, `.mts`, `.cts`   |
  | Python                  | `.py`                            |
  | Go                      | `.go`                            |

- The distinction between "structured index" and "vector index" for
  unsupported extensions.
- A short note that `require()` based CommonJS imports and assignment-style
  CommonJS exports (`module.exports`, `exports.foo`) are not extracted as
  structured declarations or imports in Phase 1.
- A short note on how to request additional languages.

## Acceptance Criteria

- [ ] `.mjs`, `.cjs`, `.mts`, and `.cts` files are routed to the TypeScript
      structured parser (`tests/unit/plugins/languages/typescript.test.ts`).
- [ ] After `--reindex --full`, `.mjs` declarations and imports appear in the
      structured index (`tests/unit/indexer/pipeline-structured-lifecycle.test.ts`).
- [ ] After `--reindex --full`, the persisted `.mjs` ES import is directly
      observable in the active generation through the test-only
      `getActiveImportsForFile(filePath)` helper; no production API or interface
      is added for test introspection.
- [ ] Unsupported extensions continue to receive vector chunks only and are
      clearly documented as unsupported for structured indexing.
- [ ] Existing `.ts` / `.tsx` / `.js` / `.jsx` behavior does not regress
      (`tests/unit/plugins/languages/typescript.test.ts` and
      `tests/unit/structured/typescript-parser.test.ts`).
- [ ] `docs/structured-index.md` exists and lists all currently registered
      structured-index language extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`,
      `.cjs`, `.mts`, `.cts`, `.py`, and `.go`.
- [ ] No new language plugins, parser frameworks, or dependencies are added
      beyond the TypeScript-family extension routing and documentation.

## Future Work (Out of Scope)

- Python extension additions (`.pyi`, `.pyw`).
- Additional structured-index languages require separate requirements and
  design work.
- Improved CommonJS `require()` / `module.exports` / `exports.foo` semantic
  extraction.
