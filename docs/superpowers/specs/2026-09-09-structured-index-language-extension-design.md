# Nexus 構造化インデックス対応言語・拡張子拡張 設計

## Status

Design is complete. The implementation plan will be created at
`docs/superpowers/plans/2026-09-09-structured-index-language-extension.md` after
this design is approved.

## Context

Nexus currently provides structured symbol retrieval for TypeScript / JavaScript,
Python, and Go. The `LanguagePlugin` contract routes files by extension and,
when a plugin exposes `createStructuredParser`, feeds the file into a structured
parser that produces `StructuredDeclaration`, `StructuredImport`, and
`StructuredGeneration` records. These records power `get_file_outline`,
`get_symbol_source`, and `get_symbol_context`.

This design extends the structured indexing experience to Rust, Java, C#,
C, C++, and Python type stubs (`.pyi`). The new languages must provide the
same guarantees as existing languages: outline, qualified names, parent-child
structure, stable `symbolId`, exact source retrieval, bounded context,
partial-parse resilience, and fail-closed handling when structured parsing
fails.

## Goal

Add structured indexing support for:

- Rust (`.rs`)
- Java (`.java`)
- C# (`.cs`)
- C (`.c`)
- C++ (`.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`)
- Python type stubs (`.pyi`)

The new languages must integrate with the existing structured catalog and MCP
retrieval tools without changing public tool schemas beyond extending the
`SymbolKind` enumeration.

## Non-Goals

- Replacing the existing TypeScript, Python, or Go parsers.
- Compiler-level semantic resolution (macro expansion, type inference,
  annotation processors, source generators, `compile_commands.json`, include
  path resolution).
- Adding languages outside the listed set (Ruby, PHP, Kotlin, Swift, etc.).
- Introducing new MCP tools or retrieval APIs.
- Changing the `LanguagePlugin` contract or the structured catalog schema.

## Architecture

### 1. Parser framework: Tree-sitter

All new languages use the same `tree-sitter` foundation already used by Python
and Go. The following grammar packages are added as dependencies:

- `tree-sitter-rust`
- `tree-sitter-java`
- `tree-sitter-c-sharp`
- `tree-sitter-cpp`

C and C++ share the C/C++ grammar. `.h` is treated as C++ explicitly per the
requirements. `.pyi` reuses the existing `tree-sitter-python` grammar.

Each language plugin follows the established two-layer pattern:

- `{language}.ts` — `LanguagePlugin` implementation that registers extensions,
  loads the tree-sitter runtime, and exposes both `createParser` and
  `createStructuredParser`.
- `{language}-structured.ts` — `StructuredLanguageParser` implementation that
  drives tree-sitter, computes offsets and diagnostics, and emits
  `StructuredParseResult`.
- `{language}-structured-declarations.ts` — AST traversal that produces
  declaration descriptors (name, kind, qualified name, scope, range).
- `{language}-structured-imports.ts` — extraction of import/include/use/using
  statements into `StructuredImport` records.
- `{language}-structured-support.ts` — shared helpers such as position/byte
  conversion, signature normalization, and syntax-problem detection.

### 2. Language plugin registration

`src/server/factory.ts` registers the new plugins in `setupPluginRegistry`:

```text
TypeScriptLanguagePlugin
PythonLanguagePlugin
GoLanguagePlugin
RustLanguagePlugin
JavaLanguagePlugin
CSharpLanguagePlugin
CLanguagePlugin
CppLanguagePlugin
```

Plugin order is not significant because each plugin owns disjoint extensions.
The `PluginRegistry` returns the first plugin whose `supports()` returns true.

### 3. Extension routing

| Language plugin | `languageId` | `fileExtensions` |
| --------------- | ------------ | ---------------- |
| TypeScript      | `typescript` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` |
| Python          | `python`     | `.py`, `.pyi` |
| Go              | `go`         | `.go` |
| Rust            | `rust`       | `.rs` |
| Java            | `java`       | `.java` |
| C#              | `csharp`     | `.cs` |
| C               | `c`          | `.c` |
| C++             | `cpp`        | `.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx` |

`IndexPipeline.detectLanguage` returns `plugin.languageId` for routed files and
falls back to `text` otherwise, matching the existing behavior.

### 4. SymbolKind extension

The existing `SymbolKind` union is extended with language-specific kinds:

```typescript
export type SymbolKind =
  | 'file'
  | 'module'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'typeAlias'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'variable'
  | 'constant'
  | 'constructor'
  | 'import'
  | 'comment'
  | 'unknown'
  | 'struct'   // Rust struct, C/C++ struct, C# struct
  | 'trait'    // Rust trait
  | 'impl'     // Rust impl block
  | 'record'   // Java / C# record
  | 'field';   // Java field (C# / C / C++ member variables are out of scope)
```

Existing kinds are preserved unchanged. New kinds are additive, so existing
symbols keep the same `symbolId`.

C# properties are mapped to `property`; C# / C / C++ member variables are
intentionally out of scope for this change.

### 5. Language-specific declaration mapping

| Language | Constructs | Mapped `SymbolKind` |
| -------- | ---------- | ------------------- |
| Rust | `struct` | `struct` |
|      | `enum` | `enum` |
|      | `trait` | `trait` |
|      | `impl` | `impl` |
|      | `impl` method | `method` |
|      | `fn` | `function` |
|      | `mod` | `namespace` |
| Java | `package` | `namespace` |
|      | class | `class` |
|      | interface | `interface` |
|      | enum | `enum` |
|      | record | `record` |
|      | method | `method` |
|      | constructor | `constructor` |
|      | field | `field` |
| C# | namespace | `namespace` |
|    | class | `class` |
|    | interface | `interface` |
|    | struct | `struct` |
|    | enum | `enum` |
|    | record | `record` |
|    | method | `method` |
|    | constructor | `constructor` |
|    | property | `property` |
| C | function | `function` |
|   | struct | `struct` |
|   | enum | `enum` |
| C++ | namespace | `namespace` |
|     | function | `function` |
|     | struct | `struct` |
|     | class | `class` |
|     | enum | `enum` |
|     | method | `method` |
|     | constructor | `constructor` |
| Python `.pyi` | class | `class` |
|               | function | `function` |
|               | method | `method` |

### 6. Container and parent-child handling

- Rust `mod`, C# `namespace`, C++ `namespace`, and Java `package` (when a
  `package` declaration is present) are represented as `namespace` declarations
  that own nested declarations. The Java `package` declaration itself is listed
  in §5 as a `namespace` declaration.
- Rust `impl` is represented as `impl` and acts as a container for its methods.
- Java / C# / C++ nested classes, structs, and namespaces contribute to
  qualified names using `.` as the separator, matching the existing TypeScript
  convention.
- Rust modules and traits use `::` in source notation (e.g. `module::Trait`,
  `Type::method`). The canonical `qualifiedName` stored in the catalog uses
  `.` as the separator for consistency with the catalog contract
  (e.g. `module.Trait`, `Type.method`). Source-language semantics are captured
  by `languageId`.

### 7. Stable symbol identity

`createSymbolId` from `src/structured/identity.ts` is used unchanged. The
identity inputs are:

- `filePath`
- `qualifiedName`
- `kind`
- `signatureDiscriminator`
- `occurrence`

Discriminator generation follows the existing pattern: a normalized signature
string up to the declaration body. For overloads, constructors, and nested
types, the signature and occurrence fields guarantee distinct stable IDs.

### 8. Import / include / use / using representation

`StructuredImport` records are produced for each language's import-like syntax.
The table below is the authoritative mapping from source construct to
`StructuredImport` for all new languages. Import-like constructs are not
represented as `StructuredDeclaration` records and do not receive a
`symbolId` or `parentSymbolId`.
| Language | Syntax | `moduleSpecifier` | `bindingName` |
| -------- | ------ | ----------------- | ------------- |
| Rust | `use std::fs::File;` | `std::fs::File` | `File` |
|      | `use std::fs::*;` | `std::fs` | `undefined` (partial) |
| Java | `import java.util.List;` | `java.util.List` | `List` |
|      | `import java.util.*;` | `java.util` | `undefined` (partial) |
| C# | `using System;` | `System` | `undefined` |
|    | `using static System.Math;` | `System.Math` | `undefined` (partial) |
| C/C++ | `#include <stdio.h>` | `stdio.h` | `undefined` |
|       | `#include "local.h"` | `local.h` | `undefined` |
| Python `.pyi` | same as `.py` | same as `.py` | same as `.py` |

Bindings with unresolved or wildcard imports are marked `completeness: 'partial'`.

### 9. Partial parse and fallback

- Tree-sitter produces partial trees for files with syntax errors.
- Declarations whose own node, range node, or scope node contains an
  `ERROR` / `MISSING` node are skipped.
- Remaining valid declarations are emitted with status `degraded` / `partial`.
- Normal/search chunk generation uses the fixed-line path via `createParser()`
  and is independent of the structured path. A failure in the structured path
  therefore does not cause a fallback to normal indexing; it only decides
  whether the structured catalog is updated in that pass.
- In an incremental update, a structured parse failure causes the file to be
  routed to the dead-letter queue; neither the structured catalog nor the
  normal chunk vectors for that file are updated in that pass. This matches
  the existing fail-closed semantics.
- In a full rebuild (`nexus --reindex --full`), any structured parse failure
  aborts the entire rebuild, preserving the existing fail-closed semantics.
  If future requirements demand that unparseable files be ignored during a
  full rebuild, `src/indexer/pipeline.ts` and its full-rebuild integration
  tests must be changed explicitly.
- Parser load failures in the structured path are not caught by the normal
  `createParser()` wrapper; `readStructuredFile` calls
  `plugin.createStructuredParser()` directly and converts exceptions into
  `parse-failed`.
- A valid structured result that contains imports but no declarations is kept
  as structured work so that import-only files (e.g. a C/C++ header with only
  `#include` directives) persist their imports in the structured catalog. The
  structured parser is retired only when both declarations and imports are
  empty.

### 10. Incremental integration

No dedicated migration operation is required. Newly created or modified files
with the supported extensions are discovered by the normal file watcher and
incremental scan flows, and are structured-indexed on the next update.

However, files that already existed in a workspace before this feature is
deployed and have not changed since are not reprocessed automatically; a stale
but successful index is not rebuilt solely because it is old (see `SPEC.md`
§4.1). To backfill existing unchanged files with the new extensions, run
`nexus --reindex --full`.

## Change List

### Production code

1. `package.json`
   - Add `tree-sitter-rust`, `tree-sitter-java`, `tree-sitter-c-sharp`,
     `tree-sitter-cpp` to `dependencies`.
2. `src/types/index.ts`
   - Extend `SymbolKind` with `struct`, `trait`, `impl`, `record`, `field`.
3. New language plugin modules under `src/plugins/languages/`:
   - `rust.ts`, `rust-structured.ts`, `rust-structured-declarations.ts`,
     `rust-structured-imports.ts`, `rust-structured-support.ts`
   - `java.ts`, `java-structured.ts`, `java-structured-declarations.ts`,
     `java-structured-imports.ts`, `java-structured-support.ts`
   - `csharp.ts`, `csharp-structured.ts`, `csharp-structured-declarations.ts`,
     `csharp-structured-imports.ts`, `csharp-structured-support.ts`
   - `c.ts`, `c-structured.ts`, `c-structured-declarations.ts`,
     `c-structured-imports.ts`, `c-structured-support.ts`
   - `cpp.ts`, `cpp-structured.ts`, `cpp-structured-declarations.ts`,
     `cpp-structured-imports.ts`, `cpp-structured-support.ts`
4. `src/plugins/languages/python.ts`
   - Add `.pyi` to `fileExtensions`.
   - The structured parser already handles Python syntax; no grammar change is
     needed.
5. `src/server/factory.ts`
   - Import and register the new language plugins in
     `NexusServerFactory.setupPluginRegistry`.
6. `docs/mcp-tools.md`
   - Update the `SymbolKind` list in the structured retrieval section.
7. `src/indexer/pipeline.ts`
   - Update `readStructuredFile` so that a valid structured result with zero
     declarations but non-zero imports is kept as structured work instead of
     being retired. Do not change the fail-closed semantics: incremental
     structured parse failures still route to the DLQ, and full-rebuild
     structured parse failures still abort the rebuild.

### Documentation

1. `docs/structured-index.md`
   - Add a "Supported languages and extensions" table that includes the new
     languages and extensions.
   - Clarify that `.h` is parsed as C++.
   - Note the C/C++ source-only parsing limitation.
2. Upgrade / backfill documentation in `docs/structured-index.md` or
   `docs/setup.md`
   - Document that existing unchanged files require `nexus --reindex --full`
     to backfill structured indexing after upgrading to the new language set.

### Tests

1. New unit tests under `tests/unit/structured/`:
   - `rust-parser.test.ts`
   - `java-parser.test.ts`
   - `csharp-parser.test.ts`
   - `c-parser.test.ts`
   - `cpp-parser.test.ts`
   - `python-pyi-parser.test.ts`
2. New fixtures under `tests/fixtures/structured/`:
   - `rust/exactness.rs`, `rust/partial.rs`
   - `java/Exactness.java`, `java/Partial.java`
   - `csharp/Exactness.cs`, `csharp/Partial.cs`
   - `c/exactness.c`, `c/partial.c`
   - `cpp/exactness.cpp`, `cpp/exactness.h`, `cpp/partial.cpp`
   - `python/exactness.pyi`, `python/partial.pyi`
3. Plugin routing tests in existing language test files or a new
   `tests/unit/plugins/registry.test.ts` cases for the new extensions.
4. Regression: run the full existing TypeScript, Python, and Go structured
   parser suites and verify no `symbolId`, kind, or source-range regressions.
5. Pipeline integration tests
   - Structured parse failure in an incremental update routes the file to the
     dead-letter queue.
   - Structured parse failure in a full rebuild aborts the rebuild.
   - An import-only C/C++ fixture persists its `#include` records in the
     structured catalog.
   - A full reindex backfills existing unchanged files with newly supported
     extensions.

## Test Strategy

Each new language parser test covers the record families separately.

**StructuredDeclaration tests**

- The required declaration families from §5 Language-specific declaration
  mapping are detected.
- Each detected declaration has a stable `symbolId` matching the
  `symbol_v1_` prefix and distinct for overloads / constructors.
- `qualifiedName` reflects the logical nesting path.
- `parentSymbolId` links child methods / constructors / fields to their owning
  type or namespace.
- `rawSource`, `startByte`, `endByte`, and `sourceHash` match the original file
  bytes.
- Files with intentional syntax errors keep their unaffected declarations and
  report `status: 'degraded'` / `retrievability: 'partial'`.

**StructuredImport tests**

- The import-like statements listed in §8 Import / include / use / using
  representation are extracted as `StructuredImport` records.
- `moduleSpecifier` and `bindingName` match the source construct.
- Wildcard / unresolved imports are marked `completeness: 'partial'`.
- `startByte`, `endByte`, and `sourceHash` match the original file bytes.
- Files that contain imports but no declarations still return valid imports.

**Pipeline failure tests**

- Completely unparseable files do not corrupt the pipeline. In an incremental
  update they are routed to the dead-letter queue; in a full rebuild they abort
  the rebuild.

The full repository quality checks (`npm run build`, `npm run lint`,
`npx tsc --noEmit`, `npx vitest run`) must pass before the implementation is
considered complete.

## Risks and Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Tree-sitter native addons fail to install or load on some environments. | Normal chunking via `createParser()` falls back to fixed-line; the structured path via `createStructuredParser()` returns `parse-failed`. |
| C/C++ grammar produces different node shapes for C and C++ constructs. | The C and C++ plugins are separate and use grammar-specific selectors; shared helpers are only used where the node shapes align. |
| `.h` parsed as C++ may misclassify pure C headers. | Documented limitation; behavior is explicit per requirements. |
| New `SymbolKind` values may surprise existing clients. | Kinds are additive; existing values are unchanged. `docs/mcp-tools.md` is updated to list the new kinds. |
| Existing `symbolId` for TypeScript / Python / Go may shift. | The identity inputs are unchanged for those languages; the new kinds are used only by new parsers. |
| Partial parse logic differs across grammars. | Each parser has its own `hasSyntaxProblem` / problem-node detection in its support module. |

## Acceptance Criteria

- [ ] `.pyi`, `.rs`, `.java`, `.cs`, `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hh`,
      `.hpp`, `.hxx` are routed to their respective structured parsers.
- [ ] Each new language recognizes the declarations listed in
      §5 Language-specific declaration mapping and produces stable `symbolId`,
      exact source, and parent-child links.
- [ ] Import / include / use / using statements listed in
      §8 Import / include / use / using representation are extracted as
      `StructuredImport` records.
- [ ] A valid structured result that contains imports but no declarations is
      kept as structured work so that import-only files (e.g. a C/C++ header
      with only `#include` directives) persist their imports in the catalog.
- [ ] Partially broken files emit valid declarations with `degraded` / `partial`
      status, and do not corrupt the index pipeline.
- [ ] Completely unparseable files do not corrupt the index pipeline. In an
      incremental update they are routed to the dead-letter queue; in a full
      rebuild they abort the rebuild.
- [ ] After `nexus --reindex --full`, existing unchanged files with newly
      supported extensions appear in the structured catalog.
- [ ] Rust declarations use the canonical `.` separator in `qualifiedName`
      (e.g. `module.Trait`, `Type.method`) so that `symbolId` is stable.
- [ ] Existing TypeScript / Python / Go structured indexing tests continue to
      pass with no `symbolId` or source-range regressions.
- [ ] `npm run build`, `npm run lint`, `npx tsc --noEmit`, and `npx vitest run`
      pass.
- [ ] `docs/structured-index.md` and `docs/mcp-tools.md` are updated with the
      new supported languages, extensions, and `SymbolKind` values.

## Future Work (Out of Scope)

- Compiler-level semantic resolution for any of the new languages.
- Macro expansion, template instantiation, or source-generator output.
- Additional languages beyond the listed set.
- Distinguishing C from C++ for `.h` files based on surrounding context.
