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

1. `src/plugins/languages/typescript.ts`
   - Update `fileExtensions` from `['.ts', '.tsx', '.js', '.jsx']` to
     `['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']`.
2. `docs/structured-index.md`
   - Create a "Supported languages and extensions" table.

### Test Strategy

Testing is split into three layers. Each layer has a single, concrete target
test file and deterministic expectations.

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

1. Create a `.mjs` source containing at least one declaration and one ES `import`.
2. Call `pipeline.reindex(..., true)` to trigger a clean full rebuild.
3. Verify the `.mjs` file is included in the structured full-rebuild input.
4. Verify the resulting structured work contains the expected declaration and
   import.
5. Verify the file has an active structured generation after the rebuild
   completes.
6. Verify the declaration is retrievable from the active structured metadata
   (`resolveFile(filePath)` returns active and `getFileDeclarations(filePath)`
   returns the expected declaration).
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
  - `getFileDeclarations(filePath)` contains the expected declaration.
  - `getActiveImportsForFile(filePath)` contains the expected ES import.

The expected ES import must be matched by at least `moduleSpecifier` and the
fixture-appropriate import identity (e.g. `bindingName` or a combination of
`moduleSpecifier`, `bindingName`, `startByte`, and `completeness`).

This test directly validates Issue #287's acceptance condition: after
`--reindex --full`, `.mjs` declarations and imports are present in the
structured index.

### Risks and Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| `.cjs` / `.cts` use `require` / `module.exports`, which are outside | Document in `docs/structured-index.md` and in test fixtures that |
| TypeScript's import syntax. | `require()` based imports and assignment-style CommonJS exports |
| | (`module.exports`, `exports.foo`) are not extracted as structured |
| | declarations or imports in Phase 1. |
| `.mjs` / `.mts` may produce syntactic parse diagnostics and fall | Valid fixtures must expect `status: 'ok'` / `retrievability: 'exact'`. |
| back to `fileCompleteness: 'partial'` / `retrievability: 'partial'`. | If a syntactic diagnostic is unavoidable, document the exact fixture, |
| Unresolved modules are handled at the import level and do not alone | reason, and expected `status: 'degraded'` / `retrievability: 'partial'` |
| degrade the file-level status. | in this design before implementation. |
| Existing `.ts` / `.tsx` / `.js` / `.jsx` behavior may regress. | Run the full TypeScript plugin test suite, structured parser tests, and |
| | pipeline structured lifecycle tests after the change. |
| Adding the four extensions to `fileExtensions` may change vector | Add a `.mjs` regression case to |
| chunking behavior for `.mjs` files that previously received | `tests/unit/indexer/chunker.test.ts` that asserts the TypeScript plugin |
| fixed-line chunks. | is selected on the legacy/vector path, vector chunks are still produced, |
| | and declaration-based chunks contain the expected symbol when a |
| | declaration is present. Files without a declaration continue to use the |
| | fixed-line fallback already provided by the chunker. |

## Documentation

Create `docs/structured-index.md` containing:

- What the structured index is.
- The "Supported languages and extensions" table:

  | Language family         | Structured extensions                                      |
  | ----------------------- | ---------------------------------------------------------- |
  | TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` |
  | Python                  | `.py`                                                      |
  | Go                      | `.go`                                                      |

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
