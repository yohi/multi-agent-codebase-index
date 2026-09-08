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

Increase the set of source files that contribute to the structured index.

- Phase 1: extend the TypeScript-family plugin to handle JavaScript/TypeScript
  module variants (`.mjs`, `.cjs`, `.mts`, `.cts`).
- Phase 2: add a Rust language plugin as the first new Tree-sitter based
  language, establishing a pattern for Ruby / PHP / Java / C / C++ later.

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
2. `tests/unit/plugins/languages/typescript.test.ts` (or a new dedicated test
   file)
   - Add fixtures for each new extension.
   - Assert that `plugin.supports(filePath)` returns `true`.
   - Assert that `createStructuredParser().parseStructured()` returns at least
     one declaration and one import, accepting either `ok` or `degraded`
     status.
3. `docs/structured-index.md`
   - Create a "Supported languages and extensions" table.

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `.cjs` / `.cts` use `require` / `module.exports`, which are outside TypeScript's import syntax. | Document that `require()` based imports are not extracted as structured imports in Phase 1. |
| `.mjs` / `.mts` may produce parse diagnostics (e.g. `import.meta`) and fall back to `fileCompleteness: 'partial'`. | Fixtures must assert that declarations and imports are still emitted under `degraded`. |
| Existing `.ts` / `.tsx` / `.js` / `.jsx` behavior may regress. | Run the full TypeScript plugin test suite and structured parser tests after the change. |

## Phase 2: Add Rust Language Plugin

### New Files

| File | Responsibility |
|------|----------------|
| `src/plugins/languages/rust.ts` | `RustLanguagePlugin`: `LanguagePlugin` implementation, dynamic Tree-sitter loader, legacy/structured parser wiring. |
| `src/plugins/languages/rust-structured.ts` | `RustStructuredParser`: top-level `parseStructured` orchestration. |
| `src/plugins/languages/rust-structured-declarations.ts` | Map Tree-sitter Rust AST nodes to `DeclarationDescriptor` values. |
| `src/plugins/languages/rust-structured-imports.ts` | Map `use_declaration` nodes to `StructuredImport` values. |
| `src/plugins/languages/rust-structured-support.ts` | Helpers for positions, signatures, byte offsets, and parse diagnostics. |

### Dependency

Add `tree-sitter-rust` to `package.json` `dependencies`. Prefer a `^0.25.0`
release to stay aligned with `tree-sitter-go` and `tree-sitter-python`.

### Implementation Pattern

Mirror the Go plugin:

- `loadTreeSitter()` imports `tree-sitter` and `tree-sitter-rust` lazily.
- `RustLanguagePlugin.createParser()` tries to load the structured parser and
  falls back to fixed-line chunking if Tree-sitter is unavailable.
- `RustLanguagePlugin.createStructuredParser()` returns a
  `RustStructuredParser` instance.

### Symbols to Extract

| Rust AST node | SymbolKind | Example |
|---------------|------------|---------|
| `function_item` | `function` | `fn foo() {}` |
| `struct_item` | `class` | `struct Foo {}` |
| `enum_item` | `enum` | `enum Foo {}` |
| `trait_item` | `interface` | `trait Foo {}` |
| `impl_item` | `class` | `impl Foo {}` |
| `function_item` inside `impl_item` | `method` | `impl Foo { fn bar() {} }` |
| `type_item` | `typeAlias` | `type Foo = Bar;` |
| `const_item` | `constant` | `const FOO: i32 = 1;` |
| `static_item` | `variable` | `static FOO: i32 = 1;` |
| `module_item` | `namespace` | `mod foo;` |
| `macro_rules_definition` | `function` | `macro_rules! foo { ... }` |

### Qualified Names and Parent Scopes

- `impl Foo { fn bar() }` produces `Foo.bar`.
- `mod foo { fn bar() }` produces `foo.bar`.
- Track parent scopes with a stack during AST traversal, similar to the Go
  parser's `parents` array.

### Import Extraction

- Capture every `use_declaration` node.
- `moduleSpecifier` is the full use path as text (e.g. `std::collections::HashMap`).
- `bindingName` is the final imported name. For `use foo::{bar, baz}` emit one
  import per binding. For `use foo::*` emit a single import with binding `*`.

### Tests

- Create `tests/unit/structured/rust-parser.test.ts`.
- Fixtures must cover:
  - free functions and structs
  - impl blocks and methods
  - use declarations
  - nested modules
  - files with syntax errors that still yield partial results

## Documentation

Create `docs/structured-index.md` containing:

- What the structured index is.
- The "Supported languages and extensions" table.
- The distinction between "structured index" and "vector index" for
  unsupported extensions.
- A short note on how to request additional languages.

## Acceptance Criteria

- [ ] `.mjs`, `.cjs`, `.mts`, and `.cts` files are routed to the TypeScript
      structured parser.
- [ ] After `--reindex --full`, `.mjs` declarations and imports appear in the
      structured index.
- [ ] Unsupported extensions continue to receive vector chunks only and are
      clearly documented as unsupported for structured indexing.
- [ ] Existing `.ts` / `.tsx` / `.js` / `.jsx` behavior does not regress.
- [ ] `docs/structured-index.md` exists and lists all supported extensions.
- [ ] A Rust plugin exists and parses `.rs` files into declarations and imports.
- [ ] Rust fixtures pass under `vitest`.

## Future Work (Out of Scope)

- Python extension additions (`.pyi`, `.pyw`).
- Additional Tree-sitter languages: Ruby, PHP, Java, C, C++.
- Extracting `require()` based imports for CommonJS.
