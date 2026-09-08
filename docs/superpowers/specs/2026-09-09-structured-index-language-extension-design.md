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

Requirement `REQUIREMENTS.md` asks to extend this experience to Rust, Java, C#,
C, C++, and Python type stubs (`.pyi`), with the same guarantees: outline,
qualified names, parent-child structure, stable `symbolId`, exact source
retrieval, bounded context, partial-parse resilience, and fallback to normal
indexing when structured parsing is unavailable.

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
  | 'field';   // Java / C# / C / C++ field or member variable
```

Existing kinds are preserved unchanged. New kinds are additive, so existing
symbols keep the same `symbolId`.

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
|      | `use` | `import` |
| Java | class | `class` |
|      | interface | `interface` |
|      | enum | `enum` |
|      | record | `record` |
|      | method | `method` |
|      | constructor | `constructor` |
|      | field | `field` |
|      | `import` | `import` |
| C# | class | `class` |
|    | interface | `interface` |
|    | struct | `struct` |
|    | enum | `enum` |
|    | record | `record` |
|    | method | `method` |
|    | constructor | `constructor` |
|    | property | `property` |
|    | namespace | `namespace` |
|    | `using` | `import` |
| C | function | `function` |
|   | struct | `struct` |
|   | enum | `enum` |
|   | `#include` | `import` |
| C++ | function | `function` |
|     | struct | `struct` |
|     | class | `class` |
|     | enum | `enum` |
|     | namespace | `namespace` |
|     | method | `method` |
|     | constructor | `constructor` |
|     | `#include` | `import` |
| Python `.pyi` | class | `class` |
|               | function | `function` |
|               | method | `method` |
|               | import | `import` |

### 6. Container and parent-child handling

- Rust `mod`, C# `namespace`, C++ `namespace`, and Java packages (when a
  `package` declaration is present) are represented as `namespace` declarations
  that own nested declarations.
- Rust `impl` is represented as `impl` and acts as a container for its methods.
- Java / C# / C++ nested classes, structs, and namespaces contribute to
  qualified names using `.` as the separator, matching the existing TypeScript
  convention.
- Rust modules and traits use qualified names such as `module::Trait` or
  `Type::method`. The separator remains `.` in `qualifiedName` for consistency
  with the catalog contract, while the source language semantics are captured
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
- If no declarations can be extracted, the file returns `parse-failed` from
  `IndexPipeline.readStructuredFile`, which routes the file to normal chunk
  indexing and records the failure only for metrics/logging.
- Parser load failures are caught by the plugin's `createParser` wrapper and
  fall back to fixed-line chunking, matching the Python plugin behavior.

### 10. Incremental integration

No migration operation is required. New files are discovered by the normal file
watcher and scan flows. Because `LanguagePlugin.supports()` is the only routing
boundary, existing workspaces will automatically start structured indexing for
new extensions on the next incremental update or full rebuild.

## Change List

### Production code

1. `package.json`
   - Add `tree-sitter-rust`, `tree-sitter-java`, `tree-sitter-c-sharp`,
     `tree-sitter-cpp` to `dependencies`.
2. `src/types/index.ts`
   - Extend `SymbolKind` with `struct`, `trait`, `impl`, `record`, `field`.
3. New language plugin modules under `src/plugins/languages/`:
   - `rust.ts`, `rust-structured.ts`, `rust-structured-declarations.ts`,
     `rust-structured-imports.ts`
   - `java.ts`, `java-structured.ts`, `java-structured-declarations.ts`,
     `java-structured-imports.ts`
   - `csharp.ts`, `csharp-structured.ts`, `csharp-structured-declarations.ts`,
     `csharp-structured-imports.ts`
   - `c.ts`, `c-structured.ts`, `c-structured-declarations.ts`,
     `c-structured-imports.ts`
   - `cpp.ts`, `cpp-structured.ts`, `cpp-structured-declarations.ts`,
     `cpp-structured-imports.ts`
4. `src/plugins/languages/python.ts`
   - Add `.pyi` to `fileExtensions`.
   - The structured parser already handles Python syntax; no grammar change is
     needed.
5. `src/server/factory.ts`
   - Import and register the new language plugins in
     `NexusServerFactory.setupPluginRegistry`.
6. `docs/mcp-tools.md`
   - Update the `SymbolKind` list in the structured retrieval section.

### Documentation

1. `docs/structured-index.md`
   - Add a "Supported languages and extensions" table that includes the new
     languages and extensions.
   - Clarify that `.h` is parsed as C++.
   - Note the C/C++ source-only parsing limitation.

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

## Test Strategy

Each new language parser test covers:

- The required declaration families from `REQUIREMENTS.md` are detected.
- Each detected declaration has a stable `symbolId` matching the
  `symbol_v1_` prefix and distinct for overloads / constructors.
- `qualifiedName` reflects the logical nesting path.
- `parentSymbolId` links child methods / constructors / fields to their owning
  type or namespace.
- `rawSource`, `startByte`, `endByte`, and `sourceHash` match the original file
  bytes.
- Import-like statements are extracted as `StructuredImport` records.
- Files with intentional syntax errors keep their unaffected declarations and
  report `status: 'degraded'` / `retrievability: 'partial'`.
- Completely unparseable files do not break the pipeline; they fall back to
  normal indexing.

The full repository quality checks (`npm run build`, `npm run lint`,
`npx tsc --noEmit`, `npx vitest run`) must pass before the implementation is
considered complete.

## Risks and Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Tree-sitter native addons fail to install or load on some environments. | The plugin's `createParser` catches parser load errors and falls back to fixed-line chunking, matching the existing Python fallback path. |
| C/C++ grammar produces different node shapes for C and C++ constructs. | The C and C++ plugins are separate and use grammar-specific selectors; shared helpers are only used where the node shapes align. |
| `.h` parsed as C++ may misclassify pure C headers. | Documented limitation; behavior is explicit per requirements. |
| New `SymbolKind` values may surprise existing clients. | Kinds are additive; existing values are unchanged. `docs/mcp-tools.md` is updated to list the new kinds. |
| Existing `symbolId` for TypeScript / Python / Go may shift. | The identity inputs are unchanged for those languages; the new kinds are used only by new parsers. |
| Partial parse logic differs across grammars. | Each parser has its own `hasSyntaxProblem` / problem-node detection in its support module. |

## Acceptance Criteria

- [ ] `.pyi`, `.rs`, `.java`, `.cs`, `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hh`,
      `.hpp`, `.hxx` are routed to their respective structured parsers.
- [ ] Each new language recognizes the declarations listed in `REQUIREMENTS.md`
      and produces stable `symbolId`, exact source, and parent-child links.
- [ ] Import / include / use / using statements are extracted as
      `StructuredImport` records.
- [ ] Partially broken files emit valid declarations with `degraded` / `partial`
      status, and do not corrupt the index pipeline.
- [ ] Completely unparseable files fall back to normal chunk indexing.
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
