# Expand Structured Index Language Coverage

## Status

Design — pending implementation plan.

## Context

Issue #287 reports that `--reindex --full` builds both a vector index and a
structured index (symbols / imports) for supported languages. Today the
TypeScript-family plugin only claims `.ts`, `.tsx`, `.js`, and `.jsx`, so
projects that use `.mjs` as their primary source form get zero symbols and
zero imports even though vector chunks are created.

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

## Phase 1: Extend TypeScript-Family File Extensions

### Why These Extensions

| Extension | Format |
|-----------|--------|
| `.mjs` | ECMAScript module (JavaScript) |
| `.cjs` | CommonJS module (JavaScript) |
| `.mts` | ECMAScript module (TypeScript) |
| `.cts` | CommonJS module (TypeScript) |

All four are variants of JavaScript/TypeScript syntax and are already parsed
by the TypeScript compiler when `allowJs: true` and `module: NodeNext` are set.
Therefore the existing `TypeScriptStructuredParser` can handle them without
structural changes.

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
- unsupported extensions (e.g. `.rs`, `.py`, `.go`) → `plugin.supports(filePath) === false`

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
6. Verify the declaration is retrievable from the active structured metadata.
7. If an existing API can verify persisted imports, use it; otherwise verify
   persistence through the existing store/coordinator test patterns. Do not add
   a production API solely for test introspection.

This test directly validates Issue #287's acceptance condition: after
`--reindex --full`, `.mjs` declarations and imports are present in the
structured index.

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `.cjs` / `.cts` use `require` / `module.exports`, which are outside TypeScript's import syntax. | Document in `docs/structured-index.md` and in test fixtures that `require()` based imports are not extracted as structured imports in Phase 1. |
| `.mjs` / `.mts` may produce parse diagnostics (e.g. unresolved `import.meta` module resolution) and fall back to `fileCompleteness: 'partial'`. | Valid fixtures must expect `status: 'ok'`. If a diagnostic is unavoidable, document the exact fixture, reason, and expected `status: 'degraded'` / `retrievability: 'partial'` in this design before implementation. |
| Existing `.ts` / `.tsx` / `.js` / `.jsx` behavior may regress. | Run the full TypeScript plugin test suite, structured parser tests, and pipeline structured lifecycle tests after the change. |

## Documentation

Create `docs/structured-index.md` containing:

- What the structured index is.
- The "Supported languages and extensions" table, listing `.ts`, `.tsx`, `.js`,
  `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` for structured indexing.
- The distinction between "structured index" and "vector index" for
  unsupported extensions.
- A short note that `require()` based CommonJS imports are not extracted as
  structured imports in Phase 1.
- A short note on how to request additional languages.

## Acceptance Criteria

- [ ] `.mjs`, `.cjs`, `.mts`, and `.cts` files are routed to the TypeScript
      structured parser (`tests/unit/plugins/languages/typescript.test.ts`).
- [ ] After `--reindex --full`, `.mjs` declarations and imports appear in the
      structured index (`tests/unit/indexer/pipeline-structured-lifecycle.test.ts`).
- [ ] Unsupported extensions continue to receive vector chunks only and are
      clearly documented as unsupported for structured indexing.
- [ ] Existing `.ts` / `.tsx` / `.js` / `.jsx` behavior does not regress
      (`tests/unit/plugins/languages/typescript.test.ts` and
      `tests/unit/structured/typescript-parser.test.ts`).
- [ ] `docs/structured-index.md` exists and lists all supported extensions.
- [ ] No new language plugins, parser frameworks, or dependencies are added
      beyond the TypeScript-family extension routing and documentation.

## Future Work (Out of Scope)

- Python extension additions (`.pyi`, `.pyw`).
- Additional structured-index languages require separate requirements and
  design work.
- Extracting `require()` based imports for CommonJS.
