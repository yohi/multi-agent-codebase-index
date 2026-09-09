# Nexus 構造化インデックス対応言語・拡張子拡張 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rust (`.rs`)、Java (`.java`)、C# (`.cs`)、C (`.c`)、C++ (`.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`)、および Python type stubs (`.pyi`) を、既存の構造化インデックスと MCP 取得ツールに統合し、新しい `SymbolKind` を追加する。

**Architecture:** すべての新言語は既存の Python / Go と同じ `tree-sitter` 基盤を使う。各言語は `LanguagePlugin` と `StructuredLanguageParser` を実装し、宣言・インポート・補助関数を分離した 2〜5 ファイルで構成する。`src/server/factory.ts` に登録し、`SymbolKind` を拡張、`src/indexer/pipeline.ts` の import-only ファイルの扱いを修正する。

**Tech Stack:** TypeScript、Node.js >=24、tree-sitter 0.25.1、新規 grammars（`tree-sitter-rust@0.24.0`、`tree-sitter-java@0.23.5`、`tree-sitter-c-sharp@0.23.5`、`tree-sitter-cpp@0.23.4`、`tree-sitter-c@0.24.1`）、vitest。

## Global Constraints

- Node.js >=24.0.0
- `tree-sitter` 0.25.1 ベース
- 新規 grammar package: `tree-sitter-rust@0.24.0`、`tree-sitter-java@0.23.5`、`tree-sitter-c-sharp@0.23.5`、`tree-sitter-cpp@0.23.4`、`tree-sitter-c@0.24.1`
- C / C++ は別プラグインとして実装する（`.h` は C++ として扱う）
- `.h` は C++ として明示的に扱う
- `.pyi` は既存 `tree-sitter-python` grammar を再利用する
- `SymbolKind` 追加は既存値を変更しない加算的拡張のみ
- `qualifiedName` はカタログ全体で `.` セパレータを使用する（Rust も `module.Trait`、`Type.method`）
- Java `package_declaration` と C# `file_scoped_namespace_declaration` は AST body container ではなく、後続 top-level declaration に適用する logical file scope として扱う
- 宣言の declaration node / range node / owning scope node のいずれかに `ERROR` / `MISSING` があれば出力せず、壊れた container の子を外側 scopeへ flatten しない
- lexical `ownerKey` は traversal 中に logical owner descriptor の `declarationKey` を直接渡して確定する。`qualifiedName` の逆引きで復元しない。Rust `impl` は構文上の走査コンテナだが論理的な親ではなく、対象型が一意のときだけ method の owner とする
- 構造化パース失敗は fail-closed: 増分更新では DLQ へ、フルリビルドでは中止
- Task 3〜6 のproduction code blockは各対象ファイルの全内容を示し、未定義のhelperや省略記号に実装を委譲しない
- `npm ci`、`npm run build`、`npm run lint`、`npx tsc --noEmit`、`npm run license:check`、`npm run test` がすべて通ること
- ロックファイルは `npm install` で再生成し、手編集禁止

---

## File Structure

### 変更ファイル

| ファイル | 責務 |
| --- | --- |
| `package.json` / `package-lock.json` | 5 つの新 tree-sitter grammar dependency を追加 |
| `src/types/index.ts` | `SymbolKind` に `struct`, `trait`, `impl`, `record`, `field` を追加 |
| `src/plugins/languages/python.ts` | `.pyi` を `fileExtensions` に追加 |
| `src/server/factory.ts` | 新しい 5 言語プラグインを `setupPluginRegistry` に登録 |
| `src/indexer/pipeline.ts` | `status === 'ok' && declarations.length === 0 && imports.length > 0` を `retire` ではなく structured work として維持 |
| `docs/mcp-tools.md` | `SymbolKind` 一覧を更新 |
| `docs/structured-index.md` | 対応言語テーブル、`.h` は C++、バックフィル手順を追加 |

### 新規ファイル（言語ごと）

| ファイル | 責務 |
| --- | --- |
| `src/plugins/languages/{lang}.ts` | `LanguagePlugin` 実装、拡張子登録、tree-sitter ロード、両パーサ提供 |
| `src/plugins/languages/{lang}-structured.ts` | `StructuredLanguageParser` 実装、tree-sitter 駆動、結果組み立て |
| `src/plugins/languages/{lang}-structured-declarations.ts` | AST 走査、宣言ディスクリプタ生成 |
| `src/plugins/languages/{lang}-structured-imports.ts` | import/include/use/using 抽出 |
| `src/plugins/languages/{lang}-structured-support.ts` | 位置/バイト変換、シグネチャ正規化、構文問題検出 |

`{lang}` は `rust`, `java`, `csharp`, `c`, `cpp` の 5 つ。`.pyi` は Python 既存パーサを流用するため新規ファイルなし。

### テスト・フィクスチャ

| ファイル | 責務 |
| --- | --- |
| `tests/unit/structured/rust-parser.test.ts` | Rust 構造化パーサの単体テスト |
| `tests/unit/structured/java-parser.test.ts` | Java 構造化パーサの単体テスト |
| `tests/unit/structured/csharp-parser.test.ts` | C# 構造化パーサの単体テスト |
| `tests/unit/structured/c-parser.test.ts` | C 構造化パーサの単体テスト |
| `tests/unit/structured/cpp-parser.test.ts` | C++ 構造化パーサの単体テスト |
| `tests/unit/structured/python-pyi-parser.test.ts` | `.pyi` 構造化パーサの単体テスト |
| `tests/unit/server/factory.test.ts` | factory-created registryによる新拡張子のルーティングテスト |
| `tests/unit/indexer/pipeline-structured-imports.test.ts` | import-only ファイル・degraded import-only ファイルのパイプライン挙動テスト |
| `tests/fixtures/structured/rust/exactness.rs` | Rust 正常 fixture |
| `tests/fixtures/structured/rust/partial.rs` | Rust 部分破損 fixture |
| `tests/fixtures/structured/java/Exactness.java` | Java 正常 fixture |
| `tests/fixtures/structured/java/PackageLess.java` | Java package-less 正常 fixture |
| `tests/fixtures/structured/java/Partial.java` | Java 部分破損 fixture |
| `tests/fixtures/structured/csharp/Exactness.cs` | C# 正常 fixture |
| `tests/fixtures/structured/csharp/FileScoped.cs` | C# file-scoped namespace 正常 fixture |
| `tests/fixtures/structured/csharp/Partial.cs` | C# 部分破損 fixture |
| `tests/fixtures/structured/c/exactness.c` | C 正常 fixture |
| `tests/fixtures/structured/c/partial.c` | C 部分破損 fixture |
| `tests/fixtures/structured/cpp/exactness.cpp` | C++ 正常 fixture |
| `tests/fixtures/structured/cpp/exactness.h` | C++ header 正常 fixture |
| `tests/fixtures/structured/cpp/partial.cpp` | C++ 部分破損 fixture |
| `tests/fixtures/structured/python/exactness.pyi` | Python stub 正常 fixture |
| `tests/fixtures/structured/python/partial.pyi` | Python stub 部分破損 fixture |

---

## Task 1: 依存関係・SymbolKind・Python `.pyi` 拡張子

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`（`npm install` で再生成）
- Modify: `src/types/index.ts:3-19`
- Modify: `src/plugins/languages/python.ts:46`
- Test: `tests/unit/plugins/languages/python.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `SymbolKind` に `struct`, `trait`, `impl`, `record`, `field` を追加。`PythonLanguagePlugin.fileExtensions` は `['.py', '.pyi']` に変更。

- [ ] **Step 1: Write the failing test**

`tests/unit/plugins/languages/python.test.ts` の `.pyi` ルーティングテストを追加（または新規作成）。

```typescript
import { describe, expect, it } from 'vitest';
import { PythonLanguagePlugin } from '../../../../src/plugins/languages/python.js';

describe('PythonLanguagePlugin', () => {
  it('routes .py and .pyi files', () => {
    const plugin = new PythonLanguagePlugin();
    expect(plugin.supports('src/module.py')).toBe(true);
    expect(plugin.supports('src/module.pyi')).toBe(true);
    expect(plugin.supports('src/module.rs')).toBe(false);
  });
});
```

`src/types/index.ts` の `SymbolKind` テストも追加。`tests/unit/types/symbol-kind.test.ts` を新規作成：

```typescript
import { describe, expect, it } from 'vitest';
import type { SymbolKind } from '../../../src/types/index.js';

describe('SymbolKind', () => {
  it('includes new language kinds', () => {
    const kinds: SymbolKind[] = ['struct', 'trait', 'impl', 'record', 'field'];
    expect(kinds).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/unit/plugins/languages/python.test.ts tests/unit/types/symbol-kind.test.ts -v
```

Expected: FAIL（`.pyi` unsupported または `SymbolKind` 型エラー）

- [ ] **Step 3: Apply minimal changes**

`package.json` の `dependencies` に追加：

```json
    "tree-sitter-c": "0.23.6",
    "tree-sitter-cpp": "0.23.4",
    "tree-sitter-c-sharp": "0.23.5",
    "tree-sitter-java": "0.23.5",
    "tree-sitter-rust": "0.24.0",
```

既存 `tree-sitter-python` / `tree-sitter-go` の近くに配置。

`src/types/index.ts` を編集：

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
  | 'struct'
  | 'trait'
  | 'impl'
  | 'record'
  | 'field';
```

`src/plugins/languages/python.ts` を編集：

```typescript
  readonly fileExtensions = ['.py', '.pyi'];
```

- [ ] **Step 4: Install dependencies and regenerate lockfile**

```bash
npm install
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/unit/plugins/languages/python.test.ts tests/unit/types/symbol-kind.test.ts -v
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/types/index.ts src/plugins/languages/python.ts tests/unit/plugins/languages/python.test.ts tests/unit/types/symbol-kind.test.ts
git commit -m "feat(structured): add SymbolKind extensions, .pyi support, and tree-sitter grammar dependencies"
```

---

## Task 2: Rust 言語プラグイン

**Files:**
- Create: `src/plugins/languages/rust-structured-support.ts`
- Create: `src/plugins/languages/rust-structured-declarations.ts`
- Create: `src/plugins/languages/rust-structured-imports.ts`
- Create: `src/plugins/languages/rust-structured.ts`
- Create: `src/plugins/languages/rust.ts`
- Test: `tests/unit/structured/rust-parser.test.ts`
- Test fixtures: `tests/fixtures/structured/rust/exactness.rs`, `tests/fixtures/structured/rust/partial.rs`

**Interfaces:**
- Consumes: `StructuredSource`, `Utf8OffsetTable`, `createUtf8OffsetTable`, `createSymbolId`, `sha256Hex`, `decodeUtf8`, `failedStructuredSource`, `Utf8SourceError`
- Produces: `RustLanguagePlugin`（`languageId='rust'`, `fileExtensions=['.rs']`）、`RustStructuredParser.parseStructured(source)`

- [ ] **Step 1: Write failing fixtures and test**

`tests/fixtures/structured/rust/exactness.rs`:

```rust
mod outer {
    pub struct Point {
        x: f64,
        y: f64,
    }

    pub enum Color {
        Red,
        Green,
    }

    impl Point {
        pub fn new(x: f64, y: f64) -> Self {
            Point { x, y }
        }
    }

    impl Point {
        pub fn new(x: f64, y: f64) -> Self {
            Point { x, y }
        }
    }

    pub trait Drawable {
        fn draw(&self);
    }

    pub struct Duplicate {
        first: i32,
    }

    pub struct Duplicate {
        second: i32,
    }

    mod nested {
        pub struct Marker;
    }
}

pub fn top_level() {}

use std::fs::File;
use std::io::*;
```

`tests/fixtures/structured/rust/partial.rs`:

```rust
pub struct Good {
    value: i32,
}

pub struct Bad {
    value: i32,
    pub fn malformed( {}
}

pub mod broken {
    pub fn inside() {}
    pub fn bad( {}
}
```

`tests/unit/structured/rust-parser.test.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RustLanguagePlugin } from '../../../src/plugins/languages/rust.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const fixturePath = (name: string): string => path.join('tests', 'fixtures', 'structured', 'rust', name);

const parseRustFixture = async (name: string) => {
  const filePath = fixturePath(name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new RustLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'rust', bytes, text });
  return { bytes, result, text };
};

describe('Rust structured parser', () => {
  it('extracts nested declarations and impl methods with stable symbolIds', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));

    expect(byName.get('outer')?.kind).toBe('namespace');
    expect(byName.get('outer.Point')?.kind).toBe('struct');
    expect(byName.get('outer.Color')?.kind).toBe('enum');
    expect(byName.get('outer.Point.impl')?.kind).toBe('impl');
    expect(byName.get('outer.Point.new')?.kind).toBe('method');
    expect(byName.get('outer.Drawable')?.kind).toBe('trait');
    expect(byName.get('outer.Drawable.draw')?.kind).toBe('function');
    expect(byName.get('outer.nested')?.kind).toBe('namespace');
    expect(byName.get('outer.nested.Marker')?.kind).toBe('struct');
    expect(byName.get('top_level')?.kind).toBe('function');
    expect(byName.get('outer.Point.new')?.parentSymbolId).toBe(byName.get('outer.Point')?.symbolId);
    expect(byName.get('outer.Point')?.symbolId).toMatch(/^symbol_v1_/);

    const pointMethods = result.declarations.filter((d) => d.qualifiedName === 'outer.Point.new');
    expect(pointMethods).toHaveLength(2);
    expect(new Set(pointMethods.map((d) => d.symbolId)).size).toBe(2);
    expect(new Set(pointMethods.map((d) => d.parentSymbolId))).toEqual(new Set([byName.get('outer.Point')?.symbolId]));

    const pointImpls = result.declarations.filter((d) => d.qualifiedName === 'outer.Point.impl');
    expect(pointImpls).toHaveLength(2);
    expect(new Set(pointImpls.map((d) => d.symbolId)).size).toBe(2);
  });

  it('keeps repeated canonical names distinct', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const duplicates = result.declarations.filter((d) => d.qualifiedName === 'outer.Duplicate');
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((d) => d.symbolId)).size).toBe(2);
  });

  it('uses dot separator in qualifiedName', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const names = result.declarations.map((d) => d.qualifiedName);
    expect(names).toContain('outer.Point');
    expect(names).toContain('outer.Point.new');
    expect(names).toContain('outer.Drawable');
    expect(names).toContain('outer.nested.Marker');
  });

  it('extracts use imports and marks wildcard imports partial', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const fileImport = result.imports.find((i) => i.moduleSpecifier === 'std::fs::File');
    const wildcard = result.imports.find((i) => i.moduleSpecifier === 'std::io' && i.bindingName === undefined);

    expect(fileImport?.bindingName).toBe('File');
    expect(fileImport?.completeness).toBe('complete');
    expect(wildcard?.completeness).toBe('partial');
  });

  it('keeps valid declarations when a later declaration is malformed', async () => {
    const { result } = await parseRustFixture('partial.rs');

    expect(result.status).toBe('degraded');
    expect(result.retrievability).toBe('partial');
    expect(result.declarations.find((d) => d.qualifiedName === 'Good')).toBeDefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'Bad')).toBeUndefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'inside')).toBeUndefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'broken.inside')).toBeUndefined();
  });

  it('matches rawSource, byte offsets, and sourceHash to the original file', async () => {
    const { bytes, result, text } = await parseRustFixture('exactness.rs');
    const point = result.declarations.find((d) => d.qualifiedName === 'outer.Point');
    expect(point?.rawSource).toBe(decodeUtf8(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)));
    expect(point?.sourceHash).toBe(sha256Hex(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)));
    expect(point?.startByte).toBe(Buffer.byteLength(text.slice(0, text.indexOf('pub struct Point')), 'utf8'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/structured/rust-parser.test.ts -v
```

Expected: FAIL with module not found / function not defined

- [ ] **Step 3: Write minimal implementation**

`src/plugins/languages/rust-structured-support.ts`:

```typescript
import type Parser from 'tree-sitter';
import type { StructuredSource } from '../../structured/contracts.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';

export const hasSyntaxProblem = (node: Parser.SyntaxNode): boolean =>
  node.isError || node.isMissing || node.children.some(hasSyntaxProblem);

export const diagnosticsFor = (node: Parser.SyntaxNode): readonly string[] => {
  const diagnostics: string[] = [];
  const visit = (current: Parser.SyntaxNode): void => {
    if (current.isError || current.isMissing) {
      diagnostics.push(`${current.type} at ${current.startPosition.row + 1}:${current.startPosition.column}`);
    }
    for (const child of current.children) visit(child);
  };
  visit(node);
  return diagnostics;
};

export const positionFor = (node: Parser.SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});

export const signatureFor = (source: StructuredSource, node: Parser.SyntaxNode): string => {
  const body = node.children.find((child) => child.type === 'block');
  return source.text.slice(node.startIndex, body?.startIndex ?? node.endIndex).replace(/\s+/gu, ' ').trim();
};

export const findDeclarationStartByte = (
  textLines: readonly string[],
  startLine: number,
  offsets: Utf8OffsetTable,
): number => {
  let lineIndex = startLine - 1;
  while (lineIndex > 0) {
    const previousLine = textLines[lineIndex - 1];
    if (previousLine === undefined) break;
    const trimmed = previousLine.trim();
    if (trimmed === '') break;
    if (trimmed.startsWith('//')) {
      lineIndex -= 1;
      continue;
    }
    break;
  }
  const charOffset = textLines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
  return offsets.byteOffsetAtUtf16(charOffset);
};
```

`src/plugins/languages/rust-structured-declarations.ts`:

```typescript
import type Parser from 'tree-sitter';
import type { SymbolKind } from '../../types/index.js';
import { hasSyntaxProblem } from './rust-structured-support.js';

export interface DeclarationDescriptor {
  readonly node: Parser.SyntaxNode;
  readonly rangeNode: Parser.SyntaxNode;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly declarationKey: string;
  readonly ownerKey?: string;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly qualifiedName: string;
}

interface UnresolvedDescriptor extends DeclarationDescriptor {
  readonly targetQualifiedName?: string;
}

interface Scope {
  readonly qualifiedName: string;
  readonly ownerKey?: string;
  readonly scopeNode?: Parser.SyntaxNode;
}

const declarationKeyFor = (node: Parser.SyntaxNode): string =>
  `${node.startIndex}:${node.endIndex}:${node.type}`;

const joinQualifiedName = (scope: string, name: string): string =>
  scope === '' ? name : `${scope}.${name}`;

const nameNodeText = (node: Parser.SyntaxNode): string | undefined => {
  const name = node.childForFieldName('name');
  return name?.text;
};

const bodyNode = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
  node.children.find((child) => child.type === 'declaration_list' || child.type === 'block');

const kindForType = (node: Parser.SyntaxNode): SymbolKind => {
  if (node.type === 'enum_item') return 'enum';
  if (node.type === 'trait_item') return 'trait';
  return 'struct';
};

const declarationFor = (
  node: Parser.SyntaxNode,
  scope: Scope,
): UnresolvedDescriptor | undefined => {
  const declarationKey = declarationKeyFor(node);
  const ownerKey = scope.ownerKey;
  const scopeNode = scope.scopeNode;
  if (node.type === 'mod_item') {
    const name = nameNodeText(node);
    if (!name) return undefined;
    return {
      node, rangeNode: node, scopeNode, declarationKey, ownerKey,
      kind: 'namespace',
      name,
      qualifiedName: joinQualifiedName(scope.qualifiedName, name),
    };
  }
  if (node.type === 'struct_item' || node.type === 'enum_item' || node.type === 'trait_item') {
    const name = nameNodeText(node);
    if (!name) return undefined;
    return {
      node, rangeNode: node, scopeNode, declarationKey, ownerKey,
      kind: kindForType(node),
      name,
      qualifiedName: joinQualifiedName(scope.qualifiedName, name),
    };
  }
  if (node.type === 'impl_item') {
    const typeNode = node.childForFieldName('type') ?? node.children.find((c) => c.type === 'type');
    const traitNode = node.childForFieldName('trait');
    const name = typeNode?.text;
    if (!name) return undefined;
    const targetQualifiedName = joinQualifiedName(scope.qualifiedName, name);
    const qualifiedName = traitNode
      ? `${joinQualifiedName(scope.qualifiedName, traitNode.text)}.${name}.impl`
      : `${targetQualifiedName}.impl`;
    return {
      node, rangeNode: node, scopeNode, declarationKey, ownerKey,
      kind: 'impl',
      name,
      qualifiedName,
      targetQualifiedName,
    };
  }
  if (node.type === 'function_item' || node.type === 'function_signature_item') {
    const name = nameNodeText(node);
    if (!name) return undefined;
    return {
      node, rangeNode: node, scopeNode, declarationKey, ownerKey,
      kind: 'function',
      name,
      qualifiedName: joinQualifiedName(scope.qualifiedName, name),
    };
  }
  return undefined;
};

const isContainer = (descriptor: UnresolvedDescriptor): boolean =>
  descriptor.kind === 'namespace' || descriptor.kind === 'impl' || descriptor.kind === 'trait';

type TypeDescriptor = Pick<UnresolvedDescriptor, 'qualifiedName' | 'declarationKey'>;

const childrenScopeFor = (
  descriptor: UnresolvedDescriptor,
  typeDescriptors: readonly TypeDescriptor[],
): Scope => {
  if (descriptor.kind === 'impl') {
    const targetQualifiedName = descriptor.targetQualifiedName ?? descriptor.qualifiedName;
    const targetCandidates = typeDescriptors.filter((candidate) => candidate.qualifiedName === targetQualifiedName);
    const target = targetCandidates.length === 1 ? targetCandidates[0] : undefined;
    return {
      qualifiedName: targetQualifiedName,
      ownerKey: target?.declarationKey,
      scopeNode: descriptor.node,
    };
  }
  return {
    qualifiedName: descriptor.qualifiedName,
    ownerKey: descriptor.declarationKey,
    scopeNode: descriptor.node,
  };
};

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const typeDescriptors: TypeDescriptor[] = [];
  const collectTypeDescriptors = (node: Parser.SyntaxNode, scope: Scope): void => {
    const descriptor = declarationFor(node, scope);
    if (descriptor === undefined) return;
    if (descriptor.kind === 'struct' || descriptor.kind === 'enum' || descriptor.kind === 'trait') {
      typeDescriptors.push(descriptor);
    }
    if (!isContainer(descriptor)) return;
    const body = bodyNode(node);
    if (body === undefined) return;
    const childScope = descriptor.kind === 'impl'
      ? { qualifiedName: descriptor.targetQualifiedName ?? descriptor.qualifiedName, scopeNode: descriptor.node }
      : { qualifiedName: descriptor.qualifiedName, ownerKey: descriptor.declarationKey, scopeNode: descriptor.node };
    for (const child of body.namedChildren) collectTypeDescriptors(child, childScope);
  };
  for (const child of root.namedChildren) collectTypeDescriptors(child, { qualifiedName: '' });

  const unresolved: UnresolvedDescriptor[] = [];
  const walk = (node: Parser.SyntaxNode, scope: Scope): void => {
    const descriptor = declarationFor(node, scope);
    if (descriptor === undefined) return;
    unresolved.push(descriptor);
    if (!isContainer(descriptor)) return;
    if (hasSyntaxProblem(node)) return;
    const body = bodyNode(node);
    if (body === undefined) return;
    const childScope = childrenScopeFor(descriptor, typeDescriptors);
    for (const child of body.namedChildren) walk(child, childScope);
  };

  for (const child of root.namedChildren) {
    walk(child, { qualifiedName: '' });
  }

  return unresolved.map(({ targetQualifiedName: _target, ...descriptor }) => descriptor);
};
```

The `impl` target lookup is an explicit Rust semantic association, not lexical
ownership reconstruction. It uses the collected type descriptors and leaves the
owner unresolved when the target name is ambiguous; lexical `ownerKey` values
are always copied directly from the active traversal scope.

`src/plugins/languages/rust-structured-imports.ts`:

```typescript
import type Parser from 'tree-sitter';
import { createHash } from 'node:crypto';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './rust-structured-support.js';

interface ModuleSpecifier {
  readonly specifier: string;
  readonly bindingName?: string;
  readonly completeness: 'complete' | 'partial';
}

const moduleSpecifiersFor = (node: Parser.SyntaxNode): readonly ModuleSpecifier[] => {
  if (node.type !== 'use_declaration') return [];
  const argument = node.childForFieldName('argument');
  if (!argument) return [];

  const recursive = (n: Parser.SyntaxNode, prefix: string): readonly ModuleSpecifier[] => {
    if (n.type === 'scoped_identifier' || n.type === 'identifier') {
      const specifier = `${prefix}${n.text}`.replace(/^::/, '');
      const bindingName = n.type === 'identifier'
        ? n.text
        : (n.childForFieldName('name')?.text ?? n.text.split('::').at(-1));
      return [{ specifier, bindingName, completeness: 'complete' }];
    }
    if (n.type === 'use_wildcard') {
      const path = n.childForFieldName('path') ?? n.children.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
      return [{
        specifier: `${prefix}${path?.text ?? ''}`.replace(/^::/, ''),
        bindingName: undefined,
        completeness: 'partial',
      }];
    }
    if (n.type === 'use_list') {
      return n.namedChildren.flatMap((child) => recursive(child, prefix));
    }
    return [];
  };

  const bindings = recursive(argument, '');
  return bindings.map((b) => ({
    specifier: b.specifier,
    bindingName: b.bindingName,
    completeness: b.completeness,
  }));
};

export const importsFor = (
  source: StructuredSource,
  root: Parser.SyntaxNode,
  offsets: Utf8OffsetTable,
): readonly StructuredImport[] => {
  const imports: StructuredImport[] = [];
  const occurrences = new Map<string, number>();

  for (const node of root.namedChildren) {
    if (node.type !== 'use_declaration' || hasSyntaxProblem(node)) continue;
    const startByte = offsets.byteOffsetAtUtf16(node.startIndex);
    const endByte = offsets.byteOffsetAtUtf16(node.endIndex);

    for (const binding of moduleSpecifiersFor(node)) {
      const importKey = `${source.filePath}:${startByte}:${binding.specifier}:${binding.bindingName ?? ''}`;
      const occurrence = occurrences.get(importKey) ?? 0;
      occurrences.set(importKey, occurrence + 1);
      const stableImportKey = `${importKey}:${occurrence}`;
      imports.push({
        id: `import_v1_${createHash('sha256').update(stableImportKey, 'utf8').digest('base64url')}`,
        moduleSpecifier: binding.specifier,
        bindingName: binding.bindingName,
        startByte,
        endByte,
        sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
        completeness: binding.completeness,
        position: positionFor(node),
      });
    }
  }

  return imports;
};
```

`src/plugins/languages/rust-structured.ts`:

```typescript
import type Parser from 'tree-sitter';
import type Rust from 'tree-sitter-rust';
import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredLanguageParser,
  StructuredParseResult,
  StructuredSource,
} from '../../structured/contracts.js';
import { decodeUtf8, sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import {
  createUtf8OffsetTable,
  failedStructuredSource,
  Utf8SourceError,
} from '../../structured/utf8-offsets.js';
import { declarationsFor } from './rust-structured-declarations.js';
import { importsFor } from './rust-structured-imports.js';
import {
  diagnosticsFor,
  findDeclarationStartByte,
  hasSyntaxProblem,
  positionFor,
  signatureFor,
} from './rust-structured-support.js';

export interface RustTreeSitterRuntime {
  readonly Parser: typeof Parser;
  readonly Rust: typeof Rust;
}

const generationFor = (source: StructuredSource, diagnostics: readonly string[]): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: 'rust',
  parserVersion: '0.24.0',
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics,
});

export class RustStructuredParser implements StructuredLanguageParser {
  constructor(private readonly runtime: RustTreeSitterRuntime) {}

  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    if (!source.bytes) {
      return {
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [],
        failure: { reasonCode: 'invariant_violation', message: 'Rust structured parsing requires original source bytes.' },
      };
    }
    const parser = new this.runtime.Parser();
    parser.setLanguage(this.runtime.Rust);
    const root = parser.parse(source.text).rootNode;
    let offsets: ReturnType<typeof createUtf8OffsetTable>;
    try {
      offsets = createUtf8OffsetTable(source.text, source.bytes);
    } catch (error) {
      if (error instanceof Utf8SourceError) return failedStructuredSource(error);
      throw error;
    }
    const textLines = source.text.split('\n');
    const diagnostics = diagnosticsFor(root);
    const occurrences = new Map<string, number>();
    const drafts: { declaration: StructuredDeclaration; ownerKey?: string; declarationKey: string }[] = [];

    for (const descriptor of declarationsFor(root)) {
      if (
        hasSyntaxProblem(descriptor.node) ||
        hasSyntaxProblem(descriptor.rangeNode) ||
        (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
      ) continue;
      const signatureDiscriminator = signatureFor(source, descriptor.node);
      const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      const startByte = findDeclarationStartByte(textLines, descriptor.rangeNode.startPosition.row + 1, offsets);
      const endByte = offsets.byteOffsetAtUtf16(descriptor.rangeNode.endIndex);
      drafts.push({
        declarationKey: descriptor.declarationKey,
        declaration: {
          symbolId: createSymbolId({
            filePath: source.filePath,
            qualifiedName: descriptor.qualifiedName,
            kind: descriptor.kind,
            signatureDiscriminator,
            occurrence,
          }),
          qualifiedName: descriptor.qualifiedName,
          kind: descriptor.kind,
          signatureDiscriminator,
          position: positionFor(descriptor.rangeNode),
          name: descriptor.name,
          startByte,
          endByte,
          sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
          languageId: source.language,
          isExact: true,
          rawSource: decodeUtf8(source.bytes.subarray(startByte, endByte)),
        },
        ownerKey: descriptor.ownerKey,
      });
    }

    const ownerSymbols = new Map(
      drafts
        .map(({ declarationKey, declaration }) => [declarationKey, declaration.symbolId]),
    );
    const declarations = drafts.map(({ declaration, ownerKey }) => {
      const parentSymbolId = ownerKey === undefined ? undefined : ownerSymbols.get(ownerKey);
      return parentSymbolId ? { ...declaration, parentSymbolId } : declaration;
    });
    const imports = importsFor(source, root, offsets);
    const generation = generationFor(source, diagnostics);

    if (diagnostics.length === 0) {
      return { status: 'ok', retrievability: 'exact', declarations, imports, generation };
    }
    return {
      status: 'degraded',
      retrievability: 'partial',
      declarations,
      imports,
      generation,
      failure: { reasonCode: 'parse_error', message: 'Rust parse diagnostics were reported.' },
    };
  }
}
```

`src/plugins/languages/rust.ts`:

```typescript
import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';
import type { StructuredLanguageParser, StructuredSource } from '../../structured/contracts.js';
import { decodeUtf8 } from '../../structured/hash.js';
import { RustStructuredParser, type RustTreeSitterRuntime } from './rust-structured.js';

const textEncoder = new TextEncoder();

const sourceFor = (file: FileToChunk): StructuredSource => ({
  filePath: file.filePath,
  language: file.language,
  bytes: file.bytes ?? textEncoder.encode(file.content),
  text: file.content,
});

const loadTreeSitter = async (): Promise<RustTreeSitterRuntime> => {
  const [parser, rust] = await Promise.all([import('tree-sitter'), import('tree-sitter-rust')]);
  return { Parser: parser.default, Rust: rust.default };
};

const projectLegacyResult = (
  result: Awaited<ReturnType<StructuredLanguageParser['parseStructured']>>,
  source: StructuredSource,
): ParsedSourceFile => {
  const declarations = result.declarations.map(({ kind, name, position, rawSource }): ParsedDeclaration => ({
    type: kind,
    name,
    startLine: position.startLine,
    endLine: position.endLine,
    content: rawSource ?? '',
  }));
  const ranges = [...new Map(result.imports.map((item) => [`${item.startByte}:${item.endByte}`, item])).values()]
    .toSorted((left, right) => left.startByte - right.startByte);
  for (const item of ranges) {
    declarations.push({
      type: 'import',
      name: 'imports',
      startLine: item.position.startLine,
      endLine: item.position.endLine,
      content: decodeUtf8(source.bytes.subarray(item.startByte, item.endByte)),
    });
  }
  return {
    rootType: 'source_file',
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};

export class RustLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'rust';

  readonly fileExtensions = ['.rs'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    const runtime = await loadTreeSitter();
    return new RustStructuredParser(runtime);
  }

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    try {
      const structured = await this.createStructuredParser();
      return {
        parse: async (file) => {
          try {
            const source = sourceFor(file);
            const structuredResult = await structured.parseStructured(source);
            if (structuredResult.status === 'ok' || structuredResult.status === 'degraded') {
              return projectLegacyResult(structuredResult, source);
            }
          } catch (error) {
            if (error instanceof Error) {
              console.warn('rust-structured-parser.fallback', error);
            }
            throw error;
          }
          return { rootType: 'source_file', declarations: [] };
        },
      };
    } catch (error) {
      if (error instanceof Error) {
        console.warn('rust-structured-parser.fallback', error);
        return { parse: async () => ({ rootType: 'source_file', declarations: [] }) };
      }
      throw error;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/structured/rust-parser.test.ts -v
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/languages/rust*.ts tests/unit/structured/rust-parser.test.ts tests/fixtures/structured/rust/
git commit -m "feat(structured): add Rust structured parser"
```

---

## Task 3: Java 言語プラグイン

**Files:**
- Create: `src/plugins/languages/java-structured-support.ts`
- Create: `src/plugins/languages/java-structured-declarations.ts`
- Create: `src/plugins/languages/java-structured-imports.ts`
- Create: `src/plugins/languages/java-structured.ts`
- Create: `src/plugins/languages/java.ts`
- Test: `tests/unit/structured/java-parser.test.ts`
- Test fixtures: `tests/fixtures/structured/java/Exactness.java`, `tests/fixtures/structured/java/PackageLess.java`, `tests/fixtures/structured/java/Partial.java`

**Interfaces:**
- Consumes: 共通ヘルパーと同じ型群
- Produces: `JavaLanguagePlugin`（`languageId='java'`, `fileExtensions=['.java']`）

- [ ] **Step 1: Write failing fixtures and test**

`tests/fixtures/structured/java/Exactness.java`:

```java
package com.example;

import java.util.List;
import java.util.*;

public class Exactness {
    public record Point(int x, int y) {}

    public interface Drawable {
        void draw();
    }

    public enum Color {
        RED, GREEN
    }

    private int field;

    public Exactness() {}

    public void method() {}
}
```

`tests/fixtures/structured/java/Partial.java`:

```java
package com.example;

class Unaffected {
}

class Broken {
    void good() {}
    void bad( {
}
```

`tests/fixtures/structured/java/PackageLess.java`:

```java
class PackageLess {
}
```

`tests/unit/structured/java-parser.test.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JavaLanguagePlugin } from '../../../src/plugins/languages/java.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const parseJavaFixture = async (name: string) => {
  const filePath = path.join('tests', 'fixtures', 'structured', 'java', name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new JavaLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'java', bytes, text });
  return { bytes, result, text };
};

describe('Java structured parser', () => {
  it('extracts package, class, interface, enum, record, constructor, method, field', async () => {
    const { bytes, result } = await parseJavaFixture('Exactness.java');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));

    expect(result.status).toBe('ok');
    expect(byName.get('com.example')?.kind).toBe('namespace');
    expect(byName.get('com.example.Exactness')?.kind).toBe('class');
    expect(byName.get('com.example.Exactness.Point')?.kind).toBe('record');
    expect(byName.get('com.example.Exactness.Drawable')?.kind).toBe('interface');
    expect(byName.get('com.example.Exactness.Color')?.kind).toBe('enum');
    expect(byName.get('com.example.Exactness.field')?.kind).toBe('field');
    expect(byName.get('com.example.Exactness.Exactness')?.kind).toBe('constructor');
    expect(byName.get('com.example.Exactness.method')?.kind).toBe('method');
    expect(byName.get('com.example.Exactness')?.parentSymbolId)
      .toBe(byName.get('com.example')?.symbolId);
    expect(byName.get('com.example.Exactness.method')?.parentSymbolId)
      .toBe(byName.get('com.example.Exactness')?.symbolId);

    const point = byName.get('com.example.Exactness.Point');
    expect(point?.rawSource).toBe(
      decodeUtf8(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)),
    );
    expect(point?.sourceHash).toBe(
      sha256Hex(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)),
    );
  });

  it('extracts imports and marks wildcard imports partial', async () => {
    const { result } = await parseJavaFixture('Exactness.java');
    const listImport = result.imports.find((i) => i.moduleSpecifier === 'java.util.List');
    const wildcard = result.imports.find((i) => i.moduleSpecifier === 'java.util');
    expect(listImport?.bindingName).toBe('List');
    expect(listImport?.completeness).toBe('complete');
    expect(wildcard?.completeness).toBe('partial');
  });

  it('keeps package-less declarations at the root scope', async () => {
    const { result } = await parseJavaFixture('PackageLess.java');
    const declaration = result.declarations.find((d) => d.qualifiedName === 'PackageLess');
    expect(declaration?.kind).toBe('class');
    expect(declaration?.parentSymbolId).toBeUndefined();
  });

  it('does not flatten declarations from a broken class into package scope', async () => {
    const { result } = await parseJavaFixture('Partial.java');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));
    expect(result.status).toBe('degraded');
    expect(byName.get('com.example.Unaffected')?.kind).toBe('class');
    expect(byName.has('com.example.Broken')).toBe(false);
    expect(byName.has('com.example.Broken.good')).toBe(false);
    expect(byName.has('good')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/structured/java-parser.test.ts -v
```

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

5つのproduction fileを次の内容で作成する。`Rust`のコードを暗黙にコピーせず、Java grammarのnode type、Javaのowner規則、Javaのimport規則をこのTask内で固定する。

`src/plugins/languages/java-structured-support.ts`:

```typescript
import type Parser from 'tree-sitter';
import type { StructuredSource } from '../../structured/contracts.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';

export const hasSyntaxProblem = (node: Parser.SyntaxNode): boolean =>
  node.isError || node.isMissing || node.children.some(hasSyntaxProblem);

export const diagnosticsFor = (root: Parser.SyntaxNode): readonly string[] => {
  const diagnostics: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.isError || node.isMissing) {
      diagnostics.push(`${node.type} at ${node.startPosition.row + 1}:${node.startPosition.column}`);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return diagnostics;
};

export const positionFor = (node: Parser.SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});

export const signatureFor = (source: StructuredSource, node: Parser.SyntaxNode): string => {
  const body = node.childForFieldName('body');
  return source.text.slice(node.startIndex, body?.startIndex ?? node.endIndex).replace(/\s+/gu, ' ').trim();
};

export const startByteFor = (node: Parser.SyntaxNode, offsets: Utf8OffsetTable): number =>
  offsets.byteOffsetAtUtf16(node.startIndex);
```

`src/plugins/languages/java-structured-declarations.ts`:

```typescript
import type Parser from 'tree-sitter';
import type { SymbolKind } from '../../types/index.js';
import { hasSyntaxProblem } from './java-structured-support.js';

export interface DeclarationDescriptor {
  readonly node: Parser.SyntaxNode;
  readonly rangeNode: Parser.SyntaxNode;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly declarationKey: string;
  readonly ownerKey?: string;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly qualifiedName: string;
}

type UnresolvedDescriptor = DeclarationDescriptor;

interface Scope {
  readonly qualifiedName: string;
  readonly ownerKey?: string;
  readonly scopeNode?: Parser.SyntaxNode;
}

const keyFor = (node: Parser.SyntaxNode, index = 0): string =>
  `${node.startIndex}:${node.endIndex}:${node.type}:${index}`;

const join = (scope: string, name: string): string => scope === '' ? name : `${scope}.${name}`;

const nameFor = (node: Parser.SyntaxNode): string | undefined =>
  node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'type_identifier', 'scoped_identifier'].includes(child.type))?.text;

const bodyFor = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
  node.childForFieldName('body') ?? node.namedChildren.find((child) =>
    ['class_body', 'interface_body', 'enum_body', 'record_body', 'block'].includes(child.type));

const kindFor = (node: Parser.SyntaxNode): SymbolKind | undefined => {
  switch (node.type) {
    case 'class_declaration': return 'class';
    case 'interface_declaration': return 'interface';
    case 'enum_declaration': return 'enum';
    case 'record_declaration': return 'record';
    case 'method_declaration': return 'method';
    case 'constructor_declaration': return 'constructor';
    case 'field_declaration': return 'field';
    default: return undefined;
  }
};

const descriptorsForNode = (node: Parser.SyntaxNode, scope: Scope): UnresolvedDescriptor[] => {
  if (node.type === 'package_declaration') {
    const name = nameFor(node);
    return name === undefined ? [] : [{
      node, rangeNode: node, scopeNode: scope.scopeNode,
      declarationKey: keyFor(node), ownerKey: scope.ownerKey, kind: 'namespace', name,
      qualifiedName: join(scope.qualifiedName, name),
    }];
  }

  const kind = kindFor(node);
  if (kind === undefined) return [];
  if (kind === 'field') {
    return node.namedChildren
      .filter((child) => child.type === 'variable_declarator')
      .map((child, index) => {
        const name = child.childForFieldName('name')?.text;
        return name === undefined ? undefined : {
          node, rangeNode: node, scopeNode: scope.scopeNode,
          declarationKey: keyFor(child, index), ownerKey: scope.ownerKey, kind, name,
          qualifiedName: join(scope.qualifiedName, name),
        };
      })
      .filter((descriptor): descriptor is UnresolvedDescriptor => descriptor !== undefined);
  }

  const name = nameFor(node);
  return name === undefined ? [] : [{
    node, rangeNode: node, scopeNode: scope.scopeNode,
    declarationKey: keyFor(node), ownerKey: scope.ownerKey, kind, name,
    qualifiedName: join(scope.qualifiedName, name),
  }];
};

const isContainer = (descriptor: UnresolvedDescriptor): boolean =>
  ['namespace', 'class', 'interface', 'enum', 'record'].includes(descriptor.kind);

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const packageNode = root.namedChildren.find((child) => child.type === 'package_declaration');
  const packageDescriptor = packageNode === undefined
    ? undefined
    : descriptorsForNode(packageNode, { qualifiedName: '' })[0];
  const unresolved: UnresolvedDescriptor[] = [];
  if (packageDescriptor !== undefined) unresolved.push(packageDescriptor);

  const walk = (node: Parser.SyntaxNode, scope: Scope): void => {
    const descriptors = descriptorsForNode(node, scope);
    for (const descriptor of descriptors) {
      if (descriptor.node === packageNode) continue;
      unresolved.push(descriptor);
      if (isContainer(descriptor)) {
        const body = bodyFor(node);
        if (body === undefined || hasSyntaxProblem(node)) continue;
        const childScope = {
          qualifiedName: descriptor.qualifiedName,
          ownerKey: descriptor.declarationKey,
          scopeNode: descriptor.node,
        };
        for (const child of body.namedChildren) walk(child, childScope);
      }
    }
  };

  const baseScope = packageDescriptor === undefined
    ? { qualifiedName: '' }
    : {
        qualifiedName: packageDescriptor.qualifiedName,
        ownerKey: packageDescriptor.declarationKey,
        scopeNode: packageDescriptor.node,
      };
  for (const child of root.namedChildren) {
    if (child.type === 'package_declaration' || child.type === 'import_declaration') continue;
    walk(child, baseScope);
  }
  return unresolved;
};
```

`src/plugins/languages/java-structured-imports.ts`:

```typescript
import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './java-structured-support.js';

const pathFor = (node: Parser.SyntaxNode): string | undefined =>
  node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'scoped_identifier'].includes(child.type))?.text;

export const importsFor = (
  source: StructuredSource,
  root: Parser.SyntaxNode,
  offsets: Utf8OffsetTable,
): readonly StructuredImport[] => {
  const occurrences = new Map<string, number>();
  const imports: StructuredImport[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'import_declaration' || hasSyntaxProblem(node)) continue;
    const path = pathFor(node);
    if (path === undefined) continue;
    const wildcard = path.endsWith('.*') || /\.\*\s*;\s*$/u.test(node.text);
    const moduleSpecifier = path.endsWith('.*') ? path.slice(0, -2) : path;
    const bindingName = wildcard ? undefined : moduleSpecifier.split('.').at(-1);
    const startByte = offsets.byteOffsetAtUtf16(node.startIndex);
    const endByte = offsets.byteOffsetAtUtf16(node.endIndex);
    const importKey = `${source.filePath}:${startByte}:${moduleSpecifier}:${bindingName ?? ''}`;
    const occurrence = occurrences.get(importKey) ?? 0;
    occurrences.set(importKey, occurrence + 1);
    imports.push({
      id: `import_v1_${createHash('sha256').update(`${importKey}:${occurrence}`, 'utf8').digest('base64url')}`,
      moduleSpecifier,
      bindingName,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      completeness: wildcard ? 'partial' : 'complete',
      position: positionFor(node),
    });
  }
  return imports;
};
```

`src/plugins/languages/java-structured.ts` は次の順序を固定する。

```typescript
import type Parser from 'tree-sitter';
import type Java from 'tree-sitter-java';
import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredLanguageParser,
  StructuredParseResult,
  StructuredSource,
} from '../../structured/contracts.js';
import { decodeUtf8, sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import {
  createUtf8OffsetTable,
  failedStructuredSource,
  Utf8SourceError,
} from '../../structured/utf8-offsets.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { declarationsFor, type DeclarationDescriptor } from './java-structured-declarations.js';
import { importsFor } from './java-structured-imports.js';
import {
  diagnosticsFor,
  hasSyntaxProblem,
  positionFor,
  signatureFor,
  startByteFor,
} from './java-structured-support.js';

export interface JavaTreeSitterRuntime {
  readonly Parser: typeof Parser;
  readonly Java: typeof Java;
}

const generationFor = (
  source: StructuredSource,
  diagnostics: readonly string[],
): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: 'java',
  parserVersion: '0.23.5',
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics,
});

const declarationsWithIds = (
  source: StructuredSource,
  descriptors: readonly DeclarationDescriptor[],
  offsets: Utf8OffsetTable,
): readonly StructuredDeclaration[] => {
  const occurrences = new Map<string, number>();
  const drafts = descriptors.flatMap((descriptor) => {
    if (
      hasSyntaxProblem(descriptor.node) ||
      hasSyntaxProblem(descriptor.rangeNode) ||
      (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
    ) return [];
    const signatureDiscriminator = signatureFor(source, descriptor.node);
    const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const startByte = startByteFor(descriptor.rangeNode, offsets);
    const endByte = offsets.byteOffsetAtUtf16(descriptor.rangeNode.endIndex);
    return [{
      descriptor,
      declaration: {
        symbolId: createSymbolId({
          filePath: source.filePath,
          qualifiedName: descriptor.qualifiedName,
          kind: descriptor.kind,
          signatureDiscriminator,
          occurrence,
        }),
        qualifiedName: descriptor.qualifiedName,
        kind: descriptor.kind,
        signatureDiscriminator,
        position: positionFor(descriptor.rangeNode),
        name: descriptor.name,
        startByte,
        endByte,
        sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
        languageId: source.language,
        isExact: true,
        rawSource: decodeUtf8(source.bytes.subarray(startByte, endByte)),
      },
    }];
  });
  const symbolByKey = new Map(drafts.map(({ descriptor, declaration }) => [descriptor.declarationKey, declaration.symbolId]));
  return drafts.map(({ descriptor, declaration }) => {
    const parentSymbolId = descriptor.ownerKey === undefined ? undefined : symbolByKey.get(descriptor.ownerKey);
    return parentSymbolId === undefined ? declaration : { ...declaration, parentSymbolId };
  });
};

export class JavaStructuredParser implements StructuredLanguageParser {
  constructor(private readonly runtime: JavaTreeSitterRuntime) {}

  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    if (!source.bytes) {
      return {
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [],
        failure: { reasonCode: 'invariant_violation', message: 'Java structured parsing requires source bytes.' },
      };
    }
    const parser = new this.runtime.Parser();
    parser.setLanguage(this.runtime.Java);
    const root = parser.parse(source.text).rootNode;
    let offsets: Utf8OffsetTable;
    try {
      offsets = createUtf8OffsetTable(source.text, source.bytes);
    } catch (error) {
      if (error instanceof Utf8SourceError) return failedStructuredSource(error);
      throw error;
    }
    const diagnostics = diagnosticsFor(root);
    const declarations = declarationsWithIds(source, declarationsFor(root), offsets);
    const imports = importsFor(source, root, offsets);
    const generation = generationFor(source, diagnostics);
    return diagnostics.length === 0
      ? { status: 'ok', retrievability: 'exact', declarations, imports, generation }
      : { status: 'degraded', retrievability: 'partial', declarations, imports, generation,
          failure: { reasonCode: 'parse_error', message: 'Java parse diagnostics were reported.' } };
  }
}
```

`generationFor` uses `parserId: 'java'`, grammar version `0.23.5`, the source
hash, and `fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial'`.
The shown file is complete: it owns runtime loading types, result assembly,
syntax filtering, byte/source hashing, and `parentSymbolId` materialization.
A load or UTF-8 failure returns a failed structured result and is not converted
into a successful empty result.

`src/plugins/languages/java.ts`:

```typescript
import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';
import type { StructuredLanguageParser, StructuredSource } from '../../structured/contracts.js';
import { decodeUtf8 } from '../../structured/hash.js';
import { JavaStructuredParser, type JavaTreeSitterRuntime } from './java-structured.js';

const textEncoder = new TextEncoder();

const sourceFor = (file: FileToChunk): StructuredSource => ({
  filePath: file.filePath,
  language: file.language,
  bytes: file.bytes ?? textEncoder.encode(file.content),
  text: file.content,
});

const loadTreeSitter = async (): Promise<JavaTreeSitterRuntime> => {
  const [parser, java] = await Promise.all([import('tree-sitter'), import('tree-sitter-java')]);
  return { Parser: parser.default, Java: java.default };
};

const projectLegacyResult = (
  result: Awaited<ReturnType<StructuredLanguageParser['parseStructured']>>,
  source: StructuredSource,
): ParsedSourceFile => {
  const declarations = result.declarations.map(({ kind, name, position, rawSource }): ParsedDeclaration => ({
    type: kind,
    name,
    startLine: position.startLine,
    endLine: position.endLine,
    content: rawSource ?? '',
  }));
  const ranges = [...new Map(result.imports.map((item) => [`${item.startByte}:${item.endByte}`, item])).values()]
    .toSorted((left, right) => left.startByte - right.startByte);
  for (const item of ranges) {
    declarations.push({
      type: 'import',
      name: 'imports',
      startLine: item.position.startLine,
      endLine: item.position.endLine,
      content: decodeUtf8(source.bytes.subarray(item.startByte, item.endByte)),
    });
  }
  return {
    rootType: 'program',
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};

export class JavaLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'java';
  readonly fileExtensions = ['.java'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    return new JavaStructuredParser(await loadTreeSitter());
  }

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    const structured = await this.createStructuredParser();
    return {
      parse: async (file) => {
        const source = sourceFor(file);
        const result = await structured.parseStructured(source);
        if (result.status === 'ok' || result.status === 'degraded') return projectLegacyResult(result, source);
        throw new Error(result.failure.message);
      },
    };
  }
}
```

`sourceFor` uses `file.bytes ?? new TextEncoder().encode(file.content)`. The
local `projectLegacyResult` maps every structured declaration to a legacy
declaration and maps each import range to one `import` declaration. Parser load
or parse exceptions are allowed to reject `createParser()` or its returned
`parse()` call so `Chunker` supplies the existing fixed-line fallback;
`createStructuredParser()` itself continues to throw so `readStructuredFile`
can return `parse-failed`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/structured/java-parser.test.ts -v
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/languages/java*.ts tests/unit/structured/java-parser.test.ts tests/fixtures/structured/java/
git commit -m "feat(structured): add Java structured parser"
```

---

## Task 4: C# 言語プラグイン

**Files:**
- Create: `src/plugins/languages/csharp-structured-support.ts`
- Create: `src/plugins/languages/csharp-structured-declarations.ts`
- Create: `src/plugins/languages/csharp-structured-imports.ts`
- Create: `src/plugins/languages/csharp-structured.ts`
- Create: `src/plugins/languages/csharp.ts`
- Test: `tests/unit/structured/csharp-parser.test.ts`
- Test fixtures: `tests/fixtures/structured/csharp/Exactness.cs`, `tests/fixtures/structured/csharp/Partial.cs`, `tests/fixtures/structured/csharp/FileScoped.cs`

**Interfaces:**
- Consumes: 共通ヘルパーと同じ型群
- Produces: `CSharpLanguagePlugin`（`languageId='csharp'`, `fileExtensions=['.cs']`）

- [ ] **Step 1: Write failing fixtures and test**

`tests/fixtures/structured/csharp/Exactness.cs`:

```csharp
using System;
using static System.Math;

namespace MyApp
{
    public class Exactness
    {
        public struct Point
        {
            public int X { get; set; }
        }

        public interface IDrawable
        {
            void Draw();
        }

        public enum Color { Red, Green }

        public record Person(string Name);

        public Exactness() {}

        public void Method() {}
    }
}
```

`tests/fixtures/structured/csharp/Partial.cs`:

```csharp
namespace MyApp {
public class Unaffected {}
}

namespace BrokenNamespace {
public class Broken {
    public void Good() {}
    public void Bad(
}
}
```

`tests/fixtures/structured/csharp/FileScoped.cs`:

```csharp
namespace FileScoped;

public class Container {
    public void Method() {}
}
```

`tests/unit/structured/csharp-parser.test.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSharpLanguagePlugin } from '../../../src/plugins/languages/csharp.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const parseCSharpFixture = async (name: string) => {
  const filePath = path.join('tests', 'fixtures', 'structured', 'csharp', name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new CSharpLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'csharp', bytes, text });
  return { bytes, result };
};

describe('C# structured parser', () => {
  it('extracts declarations, direct owners, exact ranges, and imports', async () => {
    const { bytes, result } = await parseCSharpFixture('Exactness.cs');
    const byName = new Map(result.declarations.map((declaration) => [declaration.qualifiedName, declaration]));

    expect(result.status).toBe('ok');
    expect(byName.get('MyApp')?.kind).toBe('namespace');
    expect(byName.get('MyApp.Exactness')?.kind).toBe('class');
    expect(byName.get('MyApp.Exactness.Point')?.kind).toBe('struct');
    expect(byName.get('MyApp.Exactness.IDrawable')?.kind).toBe('interface');
    expect(byName.get('MyApp.Exactness.Color')?.kind).toBe('enum');
    expect(byName.get('MyApp.Exactness.Person')?.kind).toBe('record');
    expect(byName.get('MyApp.Exactness.Exactness')?.kind).toBe('constructor');
    expect(byName.get('MyApp.Exactness.Method')?.kind).toBe('method');
    expect(byName.get('MyApp.Exactness.Point.X')?.kind).toBe('property');
    expect(byName.get('MyApp.Exactness.Method')?.parentSymbolId).toBe(byName.get('MyApp.Exactness')?.symbolId);
    expect(byName.get('MyApp.Exactness.Point.X')?.parentSymbolId).toBe(byName.get('MyApp.Exactness.Point')?.symbolId);

    const point = byName.get('MyApp.Exactness.Point');
    expect(point?.rawSource).toBe(decodeUtf8(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)));
    expect(point?.sourceHash).toBe(sha256Hex(bytes.subarray(point?.startByte ?? 0, point?.endByte ?? 0)));

    const regular = result.imports.find((item) => item.moduleSpecifier === 'System');
    const staticImport = result.imports.find((item) => item.moduleSpecifier === 'System.Math');
    expect(regular?.completeness).toBe('complete');
    expect(staticImport?.completeness).toBe('partial');
  });

  it('applies file-scoped namespace to following declarations', async () => {
    const { result } = await parseCSharpFixture('FileScoped.cs');
    const byName = new Map(result.declarations.map((declaration) => [declaration.qualifiedName, declaration]));
    expect(byName.get('FileScoped')?.kind).toBe('namespace');
    expect(byName.get('FileScoped.Container')?.kind).toBe('class');
    expect(byName.get('FileScoped.Container.Method')?.parentSymbolId)
      .toBe(byName.get('FileScoped.Container')?.symbolId);
  });

  it('does not flatten members from a broken class', async () => {
    const { result } = await parseCSharpFixture('Partial.cs');
    const names = new Set(result.declarations.map((declaration) => declaration.qualifiedName));
    expect(result.status).toBe('degraded');
    expect(names.has('MyApp.Unaffected')).toBe(true);
    expect(names.has('BrokenNamespace.Broken')).toBe(false);
    expect(names.has('BrokenNamespace.Broken.Good')).toBe(false);
    expect(names.has('Good')).toBe(false);
  });
});
```

C# testは各descriptor、direct owner link、import completeness、exact range/hash、
file-scoped namespace、broken container非flatteningを個別に検証する。期待:

- `MyApp` → `namespace`
- `MyApp.Exactness` → `class`
- `MyApp.Exactness.Point` → `struct`
- `MyApp.Exactness.IDrawable` → `interface`
- `MyApp.Exactness.Color` → `enum`
- `MyApp.Exactness.Person` → `record`
- `MyApp.Exactness.Exactness` → `constructor`
- `MyApp.Exactness.Method` → `method`
- `MyApp.Exactness.Point.X` → `property`
- `System` import → `moduleSpecifier: 'System', bindingName: undefined, completeness: complete`
- `System.Math` static import → `moduleSpecifier: 'System.Math', bindingName: undefined, completeness: partial`

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/structured/csharp-parser.test.ts -v
```

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

5つのproduction fileを作成し、次のC#固有の実装をそのままTaskの決定事項とする。

`src/plugins/languages/csharp-structured-support.ts`:

```typescript
import type Parser from 'tree-sitter';
import type { StructuredSource } from '../../structured/contracts.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';

export const hasSyntaxProblem = (node: Parser.SyntaxNode): boolean =>
  node.isError || node.isMissing || node.children.some(hasSyntaxProblem);

export const diagnosticsFor = (root: Parser.SyntaxNode): readonly string[] => {
  const diagnostics: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.isError || node.isMissing) {
      diagnostics.push(`${node.type} at ${node.startPosition.row + 1}:${node.startPosition.column}`);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return diagnostics;
};

export const positionFor = (node: Parser.SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});

export const signatureFor = (source: StructuredSource, node: Parser.SyntaxNode): string => {
  if (node.type === 'property_declaration') return node.text.replace(/\s+/gu, ' ').trim();
  const body = node.childForFieldName('body') ?? node.childForFieldName('declaration_list');
  return source.text.slice(node.startIndex, body?.startIndex ?? node.endIndex).replace(/\s+/gu, ' ').trim();
};

export const startByteFor = (node: Parser.SyntaxNode, offsets: Utf8OffsetTable): number =>
  offsets.byteOffsetAtUtf16(node.startIndex);
```

`hasSyntaxProblem`/`diagnosticsFor` recursively detect C# `ERROR`/`MISSING` nodes.
The range helpers use the shared UTF-8 offset table. Declaration materialization
checks the declaration node, range node, and owning scope node before emission.

`src/plugins/languages/csharp-structured-declarations.ts` の型と走査は以下で固定する。

```typescript
import type Parser from 'tree-sitter';
import type { SymbolKind } from '../../types/index.js';
import { hasSyntaxProblem } from './csharp-structured-support.js';

export interface DeclarationDescriptor {
  readonly node: Parser.SyntaxNode;
  readonly rangeNode: Parser.SyntaxNode;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly declarationKey: string;
  readonly ownerKey?: string;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly qualifiedName: string;
}

interface Scope {
  readonly qualifiedName: string;
  readonly ownerKey?: string;
  readonly scopeNode?: Parser.SyntaxNode;
}

const declarationKeyFor = (node: Parser.SyntaxNode, index = 0): string =>
  `${node.startIndex}:${node.endIndex}:${node.type}:${index}`;

const join = (scope: string, name: string): string => scope === '' ? name : `${scope}.${name}`;

const bodyFor = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
  node.childForFieldName('body') ??
  node.namedChildren.find((child) =>
    ['declaration_list', 'class_body', 'struct_body', 'enum_body', 'block'].includes(child.type));

const kindFor = (node: Parser.SyntaxNode): SymbolKind | undefined => {
  switch (node.type) {
    case 'namespace_declaration':
    case 'file_scoped_namespace_declaration': return 'namespace';
    case 'class_declaration': return 'class';
    case 'interface_declaration': return 'interface';
    case 'struct_declaration': return 'struct';
    case 'enum_declaration': return 'enum';
    case 'record_declaration': return 'record';
    case 'method_declaration': return 'method';
    case 'constructor_declaration': return 'constructor';
    case 'property_declaration': return 'property';
    default: return undefined;
  }
};

const nameFor = (node: Parser.SyntaxNode): string | undefined =>
  node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'type_identifier', 'qualified_name'].includes(child.type))?.text;

const descriptorsForNode = (node: Parser.SyntaxNode, scope: Scope): readonly DeclarationDescriptor[] => {
  const kind = kindFor(node);
  if (kind === undefined) return [];
  const name = nameFor(node);
  return name === undefined ? [] : [{
    node,
    rangeNode: node,
    scopeNode: scope.scopeNode,
    declarationKey: declarationKeyFor(node),
    ownerKey: scope.ownerKey,
    kind,
    name,
    qualifiedName: join(scope.qualifiedName, name),
  }];
};

const isContainer = (kind: SymbolKind): boolean =>
  ['namespace', 'class', 'interface', 'struct', 'enum', 'record'].includes(kind);

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const unresolved: DeclarationDescriptor[] = [];
  const walk = (node: Parser.SyntaxNode, scope: Scope): void => {
    const descriptors = descriptorsForNode(node, scope);
    if (descriptors.length > 0) {
      unresolved.push(...descriptors);
      const container = descriptors[0];
      if (container === undefined || !isContainer(container.kind)) return;
      if (
        hasSyntaxProblem(container.node) ||
        hasSyntaxProblem(container.rangeNode) ||
        (container.scopeNode !== undefined && hasSyntaxProblem(container.scopeNode))
      ) return;
      const body = bodyFor(node);
      if (body === undefined) return;
      const childScope: Scope = {
        qualifiedName: container.qualifiedName,
        ownerKey: container.declarationKey,
        scopeNode: node,
      };
      for (const child of body.namedChildren) walk(child, childScope);
      return;
    }
    for (const child of node.namedChildren) walk(child, scope);
  };

  const walkSiblings = (children: readonly Parser.SyntaxNode[], scope: Scope): void => {
    let currentScope = scope;
    for (const child of children) {
      if (child.type !== 'file_scoped_namespace_declaration') {
        walk(child, currentScope);
        continue;
      }

      const descriptor = descriptorsForNode(child, currentScope)[0];
      if (descriptor === undefined) continue;
      unresolved.push(descriptor);
      if (
        hasSyntaxProblem(descriptor.node) ||
        hasSyntaxProblem(descriptor.rangeNode) ||
        (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
      ) return;
      currentScope = {
        qualifiedName: descriptor.qualifiedName,
        ownerKey: descriptor.declarationKey,
        scopeNode: descriptor.node,
      };
    }
  };

  walkSiblings(root.namedChildren, { qualifiedName: '' });
  return unresolved;
};
```

`file_scoped_namespace_declaration` has no AST body in tree-sitter-c-sharp, so
`walkSiblings` records it once and carries its logical scope to every following
top-level declaration. If that namespace node is malformed, sibling traversal
stops instead of flattening declarations into the root scope. C# member
variables are intentionally not selected. The descriptor owner is always the
containing namespace/type descriptor; no bare class name is stored.

`src/plugins/languages/csharp-structured-imports.ts`:

```typescript
import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './csharp-structured-support.js';

const pathFor = (node: Parser.SyntaxNode): string | undefined => {
  const pathNode = node.childForFieldName('name') ?? node.namedChildren.find((child) =>
    ['identifier', 'qualified_name', 'alias_qualified_name'].includes(child.type));
  return pathNode?.text;
};

export const importsFor = (
  source: StructuredSource,
  root: Parser.SyntaxNode,
  offsets: Utf8OffsetTable,
): readonly StructuredImport[] => {
  const occurrences = new Map<string, number>();
  const imports: StructuredImport[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'using_directive' || hasSyntaxProblem(node)) continue;
    const moduleSpecifier = pathFor(node);
    if (moduleSpecifier === undefined) continue;
    const staticImport = node.text.trimStart().startsWith('using static ');
    const startByte = offsets.byteOffsetAtUtf16(node.startIndex);
    const endByte = offsets.byteOffsetAtUtf16(node.endIndex);
    const key = `${source.filePath}:${startByte}:${moduleSpecifier}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    imports.push({
      id: `import_v1_${createHash('sha256').update(`${key}:${occurrence}`, 'utf8').digest('base64url')}`,
      moduleSpecifier,
      bindingName: undefined,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      completeness: staticImport ? 'partial' : 'complete',
      position: positionFor(node),
    });
  }
  return imports;
};
```

`using System;` must therefore be `complete`, while `using static System.Math;`
must be `partial`. `id`, byte range, source hash, position, and syntax-diagnostic
filtering use the complete `using_directive` node.

`src/plugins/languages/csharp-structured.ts`:

```typescript
import type Parser from 'tree-sitter';
import type CSharp from 'tree-sitter-c-sharp';
import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredLanguageParser,
  StructuredParseResult,
  StructuredSource,
} from '../../structured/contracts.js';
import { decodeUtf8, sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import {
  createUtf8OffsetTable,
  failedStructuredSource,
  Utf8SourceError,
} from '../../structured/utf8-offsets.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { declarationsFor, type DeclarationDescriptor } from './csharp-structured-declarations.js';
import { importsFor } from './csharp-structured-imports.js';
import {
  diagnosticsFor,
  hasSyntaxProblem,
  positionFor,
  signatureFor,
  startByteFor,
} from './csharp-structured-support.js';

export interface CSharpTreeSitterRuntime {
  readonly Parser: typeof Parser;
  readonly CSharp: typeof CSharp;
}

const generationFor = (
  source: StructuredSource,
  diagnostics: readonly string[],
): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: 'csharp',
  parserVersion: '0.23.5',
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics,
});

const declarationsWithIds = (
  source: StructuredSource,
  descriptors: readonly DeclarationDescriptor[],
  offsets: Utf8OffsetTable,
): readonly StructuredDeclaration[] => {
  const occurrences = new Map<string, number>();
  const drafts = descriptors.flatMap((descriptor) => {
    if (
      hasSyntaxProblem(descriptor.node) ||
      hasSyntaxProblem(descriptor.rangeNode) ||
      (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
    ) return [];
    const signatureDiscriminator = signatureFor(source, descriptor.node);
    const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const startByte = startByteFor(descriptor.rangeNode, offsets);
    const endByte = offsets.byteOffsetAtUtf16(descriptor.rangeNode.endIndex);
    const declaration: StructuredDeclaration = {
      symbolId: createSymbolId({
        filePath: source.filePath,
        qualifiedName: descriptor.qualifiedName,
        kind: descriptor.kind,
        signatureDiscriminator,
        occurrence,
      }),
      qualifiedName: descriptor.qualifiedName,
      kind: descriptor.kind,
      signatureDiscriminator,
      position: positionFor(descriptor.rangeNode),
      name: descriptor.name,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      languageId: source.language,
      isExact: true,
      rawSource: decodeUtf8(source.bytes.subarray(startByte, endByte)),
    };
    return [{ descriptor, declaration }];
  });
  const symbolByKey = new Map(drafts.map(({ descriptor, declaration }) => [descriptor.declarationKey, declaration.symbolId]));
  return drafts.map(({ descriptor, declaration }) => {
    const parentSymbolId = descriptor.ownerKey === undefined ? undefined : symbolByKey.get(descriptor.ownerKey);
    return parentSymbolId === undefined ? declaration : { ...declaration, parentSymbolId };
  });
};

export class CSharpStructuredParser implements StructuredLanguageParser {
  constructor(private readonly runtime: CSharpTreeSitterRuntime) {}

  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    if (!source.bytes) {
      return {
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [],
        failure: { reasonCode: 'invariant_violation', message: 'C# structured parsing requires source bytes.' },
      };
    }
    const parser = new this.runtime.Parser();
    parser.setLanguage(this.runtime.CSharp);
    const root = parser.parse(source.text).rootNode;
    let offsets: Utf8OffsetTable;
    try {
      offsets = createUtf8OffsetTable(source.text, source.bytes);
    } catch (error) {
      if (error instanceof Utf8SourceError) return failedStructuredSource(error);
      throw error;
    }
    const diagnostics = diagnosticsFor(root);
    const declarations = declarationsWithIds(source, declarationsFor(root), offsets);
    const imports = importsFor(source, root, offsets);
    const generation = generationFor(source, diagnostics);
    return diagnostics.length === 0
      ? { status: 'ok', retrievability: 'exact', declarations, imports, generation }
      : {
          status: 'degraded',
          retrievability: 'partial',
          declarations,
          imports,
          generation,
          failure: { reasonCode: 'parse_error', message: 'C# parse diagnostics were reported.' },
        };
  }
}
```

`generationFor` uses `parserId: 'csharp'`, grammar version `0.23.5`, source
hash, and complete/partial file completeness. Missing bytes return a degraded
invariant result; invalid UTF-8 returns a failed structured result.
`createStructuredParser()` lets tree-sitter load errors reject so
`readStructuredFile()` converts them to `parse-failed`.

`src/plugins/languages/csharp.ts` must provide the following concrete contract:

```typescript
import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';
import type { StructuredLanguageParser, StructuredSource } from '../../structured/contracts.js';
import { decodeUtf8 } from '../../structured/hash.js';
import { CSharpStructuredParser, type CSharpTreeSitterRuntime } from './csharp-structured.js';

const textEncoder = new TextEncoder();

const sourceFor = (file: FileToChunk): StructuredSource => ({
  filePath: file.filePath,
  language: file.language,
  bytes: file.bytes ?? textEncoder.encode(file.content),
  text: file.content,
});

const loadTreeSitter = async (): Promise<CSharpTreeSitterRuntime> => {
  const [parser, csharp] = await Promise.all([import('tree-sitter'), import('tree-sitter-c-sharp')]);
  return { Parser: parser.default, CSharp: csharp.default };
};

const projectLegacyResult = (
  result: Extract<Awaited<ReturnType<StructuredLanguageParser['parseStructured']>>, { status: 'ok' | 'degraded' }>,
  source: StructuredSource,
): ParsedSourceFile => {
  const declarations = result.declarations.map(({ kind, name, position, rawSource }): ParsedDeclaration => ({
    type: kind,
    name,
    startLine: position.startLine,
    endLine: position.endLine,
    content: rawSource ?? '',
  }));
  const ranges = [...new Map(result.imports.map((item) => [`${item.startByte}:${item.endByte}`, item])).values()]
    .toSorted((left, right) => left.startByte - right.startByte);
  for (const item of ranges) {
    declarations.push({
      type: 'import',
      name: 'imports',
      startLine: item.position.startLine,
      endLine: item.position.endLine,
      content: decodeUtf8(source.bytes.subarray(item.startByte, item.endByte)),
    });
  }
  return {
    rootType: 'compilation_unit',
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};

export class CSharpLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'csharp';
  readonly fileExtensions = ['.cs'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    return new CSharpStructuredParser(await loadTreeSitter());
  }

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    const structured = await this.createStructuredParser();
    return {
      parse: async (file) => {
        const source = sourceFor(file);
        const result = await structured.parseStructured(source);
        if (result.status !== 'ok' && result.status !== 'degraded') throw new Error(result.failure.message);
        return projectLegacyResult(result, source);
      },
    };
  }
}
```

`projectLegacyResult` must throw for `failed`/`unsupported` results so the
normal chunker uses its fixed-line fallback, while `createStructuredParser`
load failures remain visible to the structured path. `sourceFor` uses original
bytes when present and otherwise encodes `file.content` with `TextEncoder`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/structured/csharp-parser.test.ts -v
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/languages/csharp*.ts tests/unit/structured/csharp-parser.test.ts tests/fixtures/structured/csharp/
git commit -m "feat(structured): add C# structured parser"
```

---

## Task 5: C 言語プラグイン

**Files:**
- Create: `src/plugins/languages/c-structured-support.ts`
- Create: `src/plugins/languages/c-structured-declarations.ts`
- Create: `src/plugins/languages/c-structured-imports.ts`
- Create: `src/plugins/languages/c-structured.ts`
- Create: `src/plugins/languages/c.ts`
- Test: `tests/unit/structured/c-parser.test.ts`
- Test fixtures: `tests/fixtures/structured/c/exactness.c`, `tests/fixtures/structured/c/partial.c`

**Interfaces:**
- Consumes: 共通ヘルパーと同じ型群
- Produces: `CLanguagePlugin`（`languageId='c'`, `fileExtensions=['.c']`）

- [ ] **Step 1: Write failing fixtures and test**

`tests/fixtures/structured/c/exactness.c`:

```c
#include <stdio.h>
#include "local.h"

struct Point {
    int x;
    int y;
};

enum Color { RED, GREEN };

void top_level(void) {
    return;
}
```

`tests/fixtures/structured/c/partial.c`:

```c
void good(void) {}
void bad( {
```

`tests/unit/structured/c-parser.test.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLanguagePlugin } from '../../../src/plugins/languages/c.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const parseCFixture = async (name: string) => {
  const filePath = path.join('tests', 'fixtures', 'structured', 'c', name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new CLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'c', bytes, text });
  return { bytes, result };
};

describe('C structured parser', () => {
  it('extracts function, struct, enum, and include imports', async () => {
    const { result } = await parseCFixture('exactness.c');
    const byName = new Map(result.declarations.map((declaration) => [declaration.qualifiedName, declaration]));

    expect(result.status).toBe('ok');
    expect(byName.get('Point')?.kind).toBe('struct');
    expect(byName.get('Color')?.kind).toBe('enum');
    expect(byName.get('top_level')?.kind).toBe('function');

    const stdio = result.imports.find((i) => i.moduleSpecifier === 'stdio.h');
    const local = result.imports.find((i) => i.moduleSpecifier === 'local.h');
    expect(stdio).toBeDefined();
    expect(local).toBeDefined();
    expect(stdio?.completeness).toBe('complete');
  });

  it('keeps exact byte ranges and skips malformed declarations without flattening', async () => {
    const { bytes, result } = await parseCFixture('partial.c');
    const byName = new Map(result.declarations.map((declaration) => [declaration.qualifiedName, declaration]));
    expect(result.status).toBe('degraded');
    expect(byName.get('good')?.kind).toBe('function');
    expect(byName.has('bad')).toBe(false);
    const good = byName.get('good');
    expect(good?.rawSource).toBe(decodeUtf8(bytes.subarray(good?.startByte ?? 0, good?.endByte ?? 0)));
    expect(good?.sourceHash).toBe(sha256Hex(bytes.subarray(good?.startByte ?? 0, good?.endByte ?? 0)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/structured/c-parser.test.ts -v
```

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

5つのproduction fileを作成する。Cはnamespace/type ownershipを推測せず、名前付きtop-levelのfunction/struct/enumだけをcatalogへ出力する。

`src/plugins/languages/c-structured-support.ts` は次を実装する。

```typescript
import type Parser from 'tree-sitter';
import type { StructuredSource } from '../../structured/contracts.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';

export const hasSyntaxProblem = (node: Parser.SyntaxNode): boolean =>
  node.isError || node.isMissing || node.children.some(hasSyntaxProblem);

export const diagnosticsFor = (root: Parser.SyntaxNode): readonly string[] => {
  const result: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.isError || node.isMissing) result.push(`${node.type}@${node.startIndex}`);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return result;
};

export const positionFor = (node: Parser.SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});

export const signatureFor = (source: StructuredSource, node: Parser.SyntaxNode): string => {
  const body = node.childForFieldName('body');
  return source.text.slice(node.startIndex, body?.startIndex ?? node.endIndex).replace(/\s+/gu, ' ').trim();
};

export const startByteFor = (node: Parser.SyntaxNode, offsets: Utf8OffsetTable): number =>
  offsets.byteOffsetAtUtf16(node.startIndex);
```

`src/plugins/languages/c-structured-declarations.ts` は次のdescriptorと
recursive selectorを使う。

```typescript
import type Parser from 'tree-sitter';
import { hasSyntaxProblem } from './c-structured-support.js';

export interface DeclarationDescriptor {
  readonly node: Parser.SyntaxNode;
  readonly rangeNode: Parser.SyntaxNode;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly declarationKey: string;
  readonly ownerKey?: string;
  readonly kind: 'function' | 'struct' | 'enum';
  readonly name: string;
  readonly qualifiedName: string;
}

const keyFor = (node: Parser.SyntaxNode): string =>
  `${node.startIndex}:${node.endIndex}:${node.type}`;

const declaratorName = (node: Parser.SyntaxNode): string | undefined => {
  const named = node.childForFieldName('declarator');
  if (named !== undefined) return declaratorName(named) ?? named.text;
  return node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'type_identifier'].includes(child.type))?.text;
};

const descriptorFor = (node: Parser.SyntaxNode): DeclarationDescriptor | undefined => {
  if (node.type === 'function_definition') {
    const name = declaratorName(node);
    return name === undefined ? undefined : {
      node, rangeNode: node, declarationKey: keyFor(node), kind: 'function', name, qualifiedName: name,
    };
  }
  if (node.type === 'struct_specifier' || node.type === 'enum_specifier') {
    const name = node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
      child.type === 'type_identifier')?.text;
    return name === undefined ? undefined : {
      node,
      rangeNode: node,
      declarationKey: keyFor(node),
      kind: node.type === 'struct_specifier' ? 'struct' : 'enum',
      name,
      qualifiedName: name,
    };
  }
  return undefined;
};

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const result: DeclarationDescriptor[] = [];
  const walk = (node: Parser.SyntaxNode): void => {
    const descriptor = descriptorFor(node);
    if (descriptor !== undefined) {
      if (!hasSyntaxProblem(descriptor.node) && !hasSyntaxProblem(descriptor.rangeNode)) result.push(descriptor);
      return;
    }
    for (const child of node.namedChildren) walk(child);
  };
  for (const child of root.namedChildren) walk(child);
  return result;
};
```

The selector traverses through `declaration` nodes to reach tagged
`struct_specifier`/`enum_specifier`, but it does not emit anonymous types or
member variables. C has no container descriptor in this scope, so
`ownerKey`/`parentSymbolId` remain absent.

`src/plugins/languages/c-structured-imports.ts`:

```typescript
import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './c-structured-support.js';

const pathFor = (node: Parser.SyntaxNode): string | undefined => {
  const pathNode = node.namedChildren.find((child) =>
    child.type === 'system_lib_string' || child.type === 'string_literal');
  if (pathNode === undefined) return undefined;
  return pathNode.text.slice(1, -1);
};

export const importsFor = (
  source: StructuredSource,
  root: Parser.SyntaxNode,
  offsets: Utf8OffsetTable,
): readonly StructuredImport[] => {
  const occurrences = new Map<string, number>();
  const imports: StructuredImport[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'preproc_include' || hasSyntaxProblem(node)) continue;
    const moduleSpecifier = pathFor(node);
    if (moduleSpecifier === undefined) continue;
    const startByte = offsets.byteOffsetAtUtf16(node.startIndex);
    const endByte = offsets.byteOffsetAtUtf16(node.endIndex);
    const key = `${source.filePath}:${startByte}:${moduleSpecifier}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    imports.push({
      id: `import_v1_${createHash('sha256').update(`${key}:${occurrence}`, 'utf8').digest('base64url')}`,
      moduleSpecifier,
      bindingName: undefined,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      completeness: 'complete',
      position: positionFor(node),
    });
  }
  return imports;
};
```

`preproc_include` is the complete record boundary. For `system_lib_string` the
angle brackets are removed, and for `string_literal` the surrounding quotes
are removed. No include resolver is introduced. A node containing
`ERROR`/`MISSING` is skipped.

`src/plugins/languages/c-structured.ts`:

```typescript
import type Parser from 'tree-sitter';
import type C from 'tree-sitter-c';
import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredLanguageParser,
  StructuredParseResult,
  StructuredSource,
} from '../../structured/contracts.js';
import { decodeUtf8, sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import {
  createUtf8OffsetTable,
  failedStructuredSource,
  Utf8SourceError,
} from '../../structured/utf8-offsets.js';
import { declarationsFor, type DeclarationDescriptor } from './c-structured-declarations.js';
import { importsFor } from './c-structured-imports.js';
import {
  diagnosticsFor,
  hasSyntaxProblem,
  positionFor,
  signatureFor,
  startByteFor,
} from './c-structured-support.js';

export interface CTreeSitterRuntime {
  readonly Parser: typeof Parser;
  readonly C: typeof C;
}

const generationFor = (
  source: StructuredSource,
  diagnostics: readonly string[],
): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: 'c',
  parserVersion: '0.23.6',
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics,
});

const declarationsWithIds = (
  source: StructuredSource,
  descriptors: readonly DeclarationDescriptor[],
  offsets: ReturnType<typeof createUtf8OffsetTable>,
): readonly StructuredDeclaration[] => {
  const occurrences = new Map<string, number>();
  const drafts = descriptors.flatMap((descriptor) => {
    if (
      hasSyntaxProblem(descriptor.node) ||
      hasSyntaxProblem(descriptor.rangeNode) ||
      (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
    ) return [];
    const signatureDiscriminator = signatureFor(source, descriptor.node);
    const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const startByte = startByteFor(descriptor.rangeNode, offsets);
    const endByte = offsets.byteOffsetAtUtf16(descriptor.rangeNode.endIndex);
    const declaration: StructuredDeclaration = {
      symbolId: createSymbolId({
        filePath: source.filePath,
        qualifiedName: descriptor.qualifiedName,
        kind: descriptor.kind,
        signatureDiscriminator,
        occurrence,
      }),
      qualifiedName: descriptor.qualifiedName,
      kind: descriptor.kind,
      signatureDiscriminator,
      position: positionFor(descriptor.rangeNode),
      name: descriptor.name,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      languageId: source.language,
      isExact: true,
      rawSource: decodeUtf8(source.bytes.subarray(startByte, endByte)),
    };
    return [{ descriptor, declaration }];
  });
  const symbolByKey = new Map(drafts.map(({ descriptor, declaration }) => [descriptor.declarationKey, declaration.symbolId]));
  return drafts.map(({ descriptor, declaration }) => {
    const parentSymbolId = descriptor.ownerKey === undefined ? undefined : symbolByKey.get(descriptor.ownerKey);
    return parentSymbolId === undefined ? declaration : { ...declaration, parentSymbolId };
  });
};

export class CStructuredParser implements StructuredLanguageParser {
  constructor(private readonly runtime: CTreeSitterRuntime) {}

  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    if (!source.bytes) {
      return {
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [],
        failure: { reasonCode: 'invariant_violation', message: 'C structured parsing requires source bytes.' },
      };
    }
    const parser = new this.runtime.Parser();
    parser.setLanguage(this.runtime.C);
    const root = parser.parse(source.text).rootNode;
    let offsets: ReturnType<typeof createUtf8OffsetTable>;
    try {
      offsets = createUtf8OffsetTable(source.text, source.bytes);
    } catch (error) {
      if (error instanceof Utf8SourceError) return failedStructuredSource(error);
      throw error;
    }
    const diagnostics = diagnosticsFor(root);
    const declarations = declarationsWithIds(source, declarationsFor(root), offsets);
    const imports = importsFor(source, root, offsets);
    const generation = generationFor(source, diagnostics);
    return diagnostics.length === 0
      ? { status: 'ok', retrievability: 'exact', declarations, imports, generation }
      : {
          status: 'degraded',
          retrievability: 'partial',
          declarations,
          imports,
          generation,
          failure: { reasonCode: 'parse_error', message: 'C parse diagnostics were reported.' },
        };
  }
}
```

`generationFor` uses `parserId: 'c'`, grammar version `0.23.6`, and the source
hash. Missing source bytes return a degraded invariant result; invalid UTF-8
returns a failed result. An import-only header with `status: 'ok'` and no
declarations remains valid work; the pipeline, not this parser, decides
persistence.

`src/plugins/languages/c.ts` must provide the complete plugin boundary:

```typescript
import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';
import type { StructuredLanguageParser, StructuredSource } from '../../structured/contracts.js';
import { decodeUtf8 } from '../../structured/hash.js';
import { CStructuredParser, type CTreeSitterRuntime } from './c-structured.js';

const textEncoder = new TextEncoder();

const sourceFor = (file: FileToChunk): StructuredSource => ({
  filePath: file.filePath,
  language: file.language,
  bytes: file.bytes ?? textEncoder.encode(file.content),
  text: file.content,
});

const loadTreeSitter = async (): Promise<CTreeSitterRuntime> => {
  const [parser, c] = await Promise.all([import('tree-sitter'), import('tree-sitter-c')]);
  return { Parser: parser.default, C: c.default };
};

const projectLegacyResult = (
  result: Extract<Awaited<ReturnType<StructuredLanguageParser['parseStructured']>>, { status: 'ok' | 'degraded' }>,
  source: StructuredSource,
): ParsedSourceFile => {
  const declarations = result.declarations.map(({ kind, name, position, rawSource }): ParsedDeclaration => ({
    type: kind,
    name,
    startLine: position.startLine,
    endLine: position.endLine,
    content: rawSource ?? '',
  }));
  const ranges = [...new Map(result.imports.map((item) => [`${item.startByte}:${item.endByte}`, item])).values()]
    .toSorted((left, right) => left.startByte - right.startByte);
  for (const item of ranges) {
    declarations.push({
      type: 'import',
      name: 'imports',
      startLine: item.position.startLine,
      endLine: item.position.endLine,
      content: decodeUtf8(source.bytes.subarray(item.startByte, item.endByte)),
    });
  }
  return {
    rootType: 'translation_unit',
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};

export class CLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'c';
  readonly fileExtensions = ['.c'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    return new CStructuredParser(await loadTreeSitter());
  }

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    const structured = await this.createStructuredParser();
    return {
      parse: async (file) => {
        const source = sourceFor(file);
        const result = await structured.parseStructured(source);
        if (result.status !== 'ok' && result.status !== 'degraded') throw new Error(result.failure.message);
        return projectLegacyResult(result, source);
      },
    };
  }
}
```

`projectLegacyResult` maps successful/degraded structured declarations and import
ranges to legacy declarations and throws for failed/unsupported results. The
normal chunker then applies its existing fixed-line fallback, while structured
load failures remain `parse-failed` in `readStructuredFile`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/structured/c-parser.test.ts -v
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/languages/c*.ts tests/unit/structured/c-parser.test.ts tests/fixtures/structured/c/
git commit -m "feat(structured): add C structured parser"
```

---

## Task 6: C++ 言語プラグイン

**Files:**
- Create: `src/plugins/languages/cpp-structured-support.ts`
- Create: `src/plugins/languages/cpp-structured-declarations.ts`
- Create: `src/plugins/languages/cpp-structured-imports.ts`
- Create: `src/plugins/languages/cpp-structured.ts`
- Create: `src/plugins/languages/cpp.ts`
- Test: `tests/unit/structured/cpp-parser.test.ts`
- Test fixtures: `tests/fixtures/structured/cpp/exactness.cpp`, `tests/fixtures/structured/cpp/exactness.h`, `tests/fixtures/structured/cpp/partial.cpp`

**Interfaces:**
- Consumes: 共通ヘルパーと同じ型群
- Produces: `CppLanguagePlugin`（`languageId='cpp'`, `fileExtensions=['.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx']`）

- [ ] **Step 1: Write failing fixtures and test**

`tests/fixtures/structured/cpp/exactness.cpp`:

```cpp
#include <vector>
#include "exactness.h"

namespace app {
    struct Point {
        int x;
        int y;
    };

    struct StructWidget {
        StructWidget();
        void render();
    };

    class Widget {
    public:
        Widget();
        void render();
    };

    class InlineWidget {
    public:
        InlineWidget() {}
        void inlineRender() {}
    };

    enum class Color { Red, Green };

    class Duplicate {
    public:
        void first();
    };

    class Duplicate {
    public:
        void second();
    };

    void freeFunction() {}
}
```

`tests/fixtures/structured/cpp/exactness.h`:

```cpp
#pragma once
#include <string>

namespace app {
    class HeaderOnly {
    public:
        void headerMethod();
    };
}
```

`tests/fixtures/structured/cpp/partial.cpp`:

```cpp
namespace app {
    void good() {}
}

namespace broken {
    void bad( {
}
```

`tests/unit/structured/cpp-parser.test.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CppLanguagePlugin } from '../../../src/plugins/languages/cpp.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const parseCppFixture = async (name: string) => {
  const filePath = path.join('tests', 'fixtures', 'structured', 'cpp', name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new CppLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'cpp', bytes, text });
  return { bytes, result };
};

describe('C++ structured parser', () => {
  it('extracts namespace, function, struct, class, enum, constructor, method', async () => {
    const { result } = await parseCppFixture('exactness.cpp');
    const byName = new Map(result.declarations.map((declaration) => [declaration.qualifiedName, declaration]));

    expect(result.status).toBe('ok');
    expect(byName.get('app')?.kind).toBe('namespace');
    expect(byName.get('app.Point')?.kind).toBe('struct');
    expect(byName.get('app.StructWidget')?.kind).toBe('struct');
    expect(byName.get('app.StructWidget.StructWidget')?.kind).toBe('constructor');
    expect(byName.get('app.StructWidget.render')?.kind).toBe('method');
    expect(byName.get('app.StructWidget.render')?.parentSymbolId)
      .toBe(byName.get('app.StructWidget')?.symbolId);
    expect(byName.get('app.Widget')?.kind).toBe('class');
    expect(byName.get('app.Widget.Widget')?.kind).toBe('constructor');
    expect(byName.get('app.Widget.render')?.kind).toBe('method');
    expect(byName.get('app.InlineWidget.InlineWidget')?.kind).toBe('constructor');
    expect(byName.get('app.InlineWidget.inlineRender')?.kind).toBe('method');
    expect(byName.get('app.Widget.render')?.parentSymbolId).toBe(byName.get('app.Widget')?.symbolId);
    expect(byName.get('app.Color')?.kind).toBe('enum');
    expect(byName.get('app.freeFunction')?.kind).toBe('function');
    const duplicateClasses = result.declarations.filter((item) => item.qualifiedName === 'app.Duplicate');
    const first = result.declarations.find((item) => item.qualifiedName === 'app.Duplicate.first');
    const second = result.declarations.find((item) => item.qualifiedName === 'app.Duplicate.second');
    expect(duplicateClasses).toHaveLength(2);
    expect(first?.parentSymbolId).toBe(duplicateClasses[0]?.symbolId);
    expect(second?.parentSymbolId).toBe(duplicateClasses[1]?.symbolId);
    expect(result.imports.find((item) => item.moduleSpecifier === 'vector')?.completeness).toBe('complete');
    expect(result.imports.find((item) => item.moduleSpecifier === 'exactness.h')?.completeness).toBe('complete');
  });

  it('treats .h as C++', async () => {
    const plugin = new CppLanguagePlugin();
    expect(plugin.supports('src/example.h')).toBe(true);
    const { result } = await parseCppFixture('exactness.h');
    expect(result.declarations.find((d) => d.qualifiedName === 'app.HeaderOnly')).toBeDefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'app.HeaderOnly.headerMethod')?.kind).toBe('method');
  });

  it('preserves valid sibling scopes and does not flatten a broken namespace', async () => {
    const { result } = await parseCppFixture('partial.cpp');
    const names = new Set(result.declarations.map((declaration) => declaration.qualifiedName));
    expect(result.status).toBe('degraded');
    expect(names.has('app.good')).toBe(true);
    expect(names.has('broken')).toBe(false);
    expect(names.has('broken.bad')).toBe(false);
    expect(names.has('bad')).toBe(false);
  });

  it('keeps exact byte ranges and hashes', async () => {
    const { bytes, result } = await parseCppFixture('exactness.cpp');
    const declaration = result.declarations.find((item) => item.qualifiedName === 'app.Widget');
    expect(declaration?.rawSource).toBe(decodeUtf8(bytes.subarray(declaration?.startByte ?? 0, declaration?.endByte ?? 0)));
    expect(declaration?.sourceHash).toBe(sha256Hex(bytes.subarray(declaration?.startByte ?? 0, declaration?.endByte ?? 0)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/structured/cpp-parser.test.ts -v
```

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

5つのproduction fileを作成する。C++のclass/struct memberは定義だけでなく宣言も対象にし、fixtureの`Widget();`、`void render();`、inline member definitionを同じselectorから抽出する。

`src/plugins/languages/cpp-structured-support.ts`:

```typescript
import type Parser from 'tree-sitter';
import type { StructuredSource } from '../../structured/contracts.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';

export const hasSyntaxProblem = (node: Parser.SyntaxNode): boolean =>
  node.isError || node.isMissing || node.children.some(hasSyntaxProblem);

export const diagnosticsFor = (root: Parser.SyntaxNode): readonly string[] => {
  const diagnostics: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.isError || node.isMissing) {
      diagnostics.push(`${node.type} at ${node.startPosition.row + 1}:${node.startPosition.column}`);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return diagnostics;
};

export const positionFor = (node: Parser.SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});

export const signatureFor = (source: StructuredSource, node: Parser.SyntaxNode): string => {
  const body = node.childForFieldName('body') ?? node.childForFieldName('declaration_list');
  return source.text.slice(node.startIndex, body?.startIndex ?? node.endIndex).replace(/\s+/gu, ' ').trim();
};

export const startByteFor = (node: Parser.SyntaxNode, offsets: Utf8OffsetTable): number =>
  offsets.byteOffsetAtUtf16(node.startIndex);
```

`hasSyntaxProblem`/`diagnosticsFor` recursively detect C++ `ERROR`/`MISSING`
nodes. The range helpers use the shared UTF-8 offset table. Declaration
materialization checks the declaration node, range node, and owning class,
struct, or namespace node before emission.

`src/plugins/languages/cpp-structured-declarations.ts` は以下のowner keyと
member selectorを実装する。

```typescript
import type Parser from 'tree-sitter';
import { hasSyntaxProblem } from './cpp-structured-support.js';

type DeclarationKind = 'namespace' | 'function' | 'struct' | 'class' | 'enum' | 'method' | 'constructor';

export interface DeclarationDescriptor {
  readonly node: Parser.SyntaxNode;
  readonly rangeNode: Parser.SyntaxNode;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly declarationKey: string;
  readonly ownerKey?: string;
  readonly kind: DeclarationKind;
  readonly name: string;
  readonly qualifiedName: string;
}

interface Scope {
  readonly qualifiedName: string;
  readonly ownerKey?: string;
  readonly scopeNode?: Parser.SyntaxNode;
  readonly typeName?: string;
}

const keyFor = (node: Parser.SyntaxNode, index = 0): string =>
  `${node.startIndex}:${node.endIndex}:${node.type}:${index}`;

const join = (scope: string, name: string): string => scope === '' ? name : `${scope}.${name}`;

const declaratorName = (node: Parser.SyntaxNode): string | undefined => {
  const nested = node.childForFieldName('declarator');
  if (nested !== undefined) return declaratorName(nested) ?? nested.text;
  return node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
    ['identifier', 'field_identifier', 'type_identifier'].includes(child.type))?.text;
};

const functionDeclaratorFor = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined => {
  if (node.type === 'function_declarator' || node.type === 'function_field_declarator') return node;
  for (const child of node.namedChildren) {
    const result = functionDeclaratorFor(child);
    if (result !== undefined) return result;
  }
  return undefined;
};

const memberDescriptorFor = (node: Parser.SyntaxNode, scope: Scope): DeclarationDescriptor | undefined => {
  if (node.type !== 'function_definition' && node.type !== 'declaration' && node.type !== 'field_declaration') return undefined;
  const declarator = functionDeclaratorFor(node);
  const name = declarator === undefined ? undefined : declaratorName(declarator);
  if (name === undefined || scope.typeName === undefined) return undefined;
  const kind = name === scope.typeName ? 'constructor' : 'method';
  return {
    node,
    rangeNode: node,
    scopeNode: scope.scopeNode,
    declarationKey: keyFor(node),
    ownerKey: scope.ownerKey,
    kind,
    name,
    qualifiedName: join(scope.qualifiedName, name),
  };
};

const descriptorFor = (node: Parser.SyntaxNode, scope: Scope): DeclarationDescriptor | undefined => {
  if (scope.typeName !== undefined) {
    const member = memberDescriptorFor(node, scope);
    if (member !== undefined) return member;
  }
  if (node.type === 'namespace_definition') {
    const name = node.childForFieldName('name')?.text;
    return name === undefined ? undefined : {
      node, rangeNode: node, scopeNode: scope.scopeNode, declarationKey: keyFor(node),
      ownerKey: scope.ownerKey, kind: 'namespace', name,
      qualifiedName: join(scope.qualifiedName, name),
    };
  }
  if (node.type === 'struct_specifier' || node.type === 'class_specifier' || node.type === 'enum_specifier') {
    const name = node.childForFieldName('name')?.text ?? node.namedChildren.find((child) =>
      child.type === 'type_identifier')?.text;
    if (name === undefined) return undefined;
    const kind = node.type === 'struct_specifier' ? 'struct' : node.type === 'class_specifier' ? 'class' : 'enum';
    return {
      node,
      rangeNode: node,
      scopeNode: scope.scopeNode,
      declarationKey: keyFor(node),
      ownerKey: scope.ownerKey,
      kind,
      name,
      qualifiedName: join(scope.qualifiedName, name),
    };
  }
  if (node.type === 'function_definition') {
    const name = declaratorName(node);
    return name === undefined ? undefined : {
      node,
      rangeNode: node,
      scopeNode: scope.scopeNode,
      declarationKey: keyFor(node),
      ownerKey: scope.ownerKey,
      kind: 'function',
      name,
      qualifiedName: join(scope.qualifiedName, name),
    };
  }
  return undefined;
};

const bodyFor = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
  node.childForFieldName('body') ?? node.namedChildren.find((child) =>
    ['declaration_list', 'field_declaration_list', 'compound_statement'].includes(child.type));

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const unresolved: DeclarationDescriptor[] = [];
  const walk = (node: Parser.SyntaxNode, scope: Scope): void => {
    const descriptor = descriptorFor(node, scope);
    if (descriptor !== undefined) {
      unresolved.push(descriptor);
      if (!['namespace', 'struct', 'class'].includes(descriptor.kind)) return;
      if (
        hasSyntaxProblem(descriptor.node) ||
        hasSyntaxProblem(descriptor.rangeNode) ||
        (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
      ) return;
      const body = bodyFor(node);
      if (body === undefined) return;
      const childScope: Scope = {
        qualifiedName: descriptor.qualifiedName,
        ownerKey: descriptor.declarationKey,
        scopeNode: node,
        ...(
          descriptor.kind === 'class' || descriptor.kind === 'struct'
            ? { typeName: descriptor.name }
            : {}
        ),
      };
      for (const child of body.namedChildren) walk(child, childScope);
      return;
    }
    for (const child of node.namedChildren) walk(child, scope);
  };

  for (const child of root.namedChildren) walk(child, { qualifiedName: '' });
  return unresolved;
};
```

`declaration` and `field_declaration` are deliberately included because
tree-sitter-cpp represents constructor/method declarations in class and struct
bodies through those nodes and a nested `function_declarator` or
`function_field_declarator`. `function_definition` covers inline definitions;
the constructor name is compared with the containing type name. No out-of-class
semantic association is attempted.

`src/plugins/languages/cpp-structured-imports.ts`:

```typescript
import { createHash } from 'node:crypto';
import type Parser from 'tree-sitter';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './cpp-structured-support.js';

const pathFor = (node: Parser.SyntaxNode): string | undefined => {
  const pathNode = node.namedChildren.find((child) =>
    child.type === 'system_lib_string' || child.type === 'string_literal');
  if (pathNode === undefined) return undefined;
  return pathNode.text.slice(1, -1);
};

export const importsFor = (
  source: StructuredSource,
  root: Parser.SyntaxNode,
  offsets: Utf8OffsetTable,
): readonly StructuredImport[] => {
  const occurrences = new Map<string, number>();
  const imports: StructuredImport[] = [];
  for (const node of root.namedChildren) {
    if (node.type !== 'preproc_include' || hasSyntaxProblem(node)) continue;
    const moduleSpecifier = pathFor(node);
    if (moduleSpecifier === undefined) continue;
    const startByte = offsets.byteOffsetAtUtf16(node.startIndex);
    const endByte = offsets.byteOffsetAtUtf16(node.endIndex);
    const key = `${source.filePath}:${startByte}:${moduleSpecifier}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    imports.push({
      id: `import_v1_${createHash('sha256').update(`${key}:${occurrence}`, 'utf8').digest('base64url')}`,
      moduleSpecifier,
      bindingName: undefined,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      completeness: 'complete',
      position: positionFor(node),
    });
  }
  return imports;
};
```

`preproc_include` is the complete record boundary. The
`system_lib_string`/`string_literal` child produces `vector`/`local.h` without
an include resolver. A node containing `ERROR`/`MISSING` is skipped.

`src/plugins/languages/cpp-structured.ts`:

```typescript
import type Parser from 'tree-sitter';
import type Cpp from 'tree-sitter-cpp';
import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredLanguageParser,
  StructuredParseResult,
  StructuredSource,
} from '../../structured/contracts.js';
import { decodeUtf8, sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import {
  createUtf8OffsetTable,
  failedStructuredSource,
  Utf8SourceError,
} from '../../structured/utf8-offsets.js';
import { declarationsFor, type DeclarationDescriptor } from './cpp-structured-declarations.js';
import { importsFor } from './cpp-structured-imports.js';
import {
  diagnosticsFor,
  hasSyntaxProblem,
  positionFor,
  signatureFor,
  startByteFor,
} from './cpp-structured-support.js';

export interface CppTreeSitterRuntime {
  readonly Parser: typeof Parser;
  readonly Cpp: typeof Cpp;
}

const generationFor = (
  source: StructuredSource,
  diagnostics: readonly string[],
): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: 'cpp',
  parserVersion: '0.23.4',
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics,
});

const declarationsWithIds = (
  source: StructuredSource,
  descriptors: readonly DeclarationDescriptor[],
  offsets: ReturnType<typeof createUtf8OffsetTable>,
): readonly StructuredDeclaration[] => {
  const occurrences = new Map<string, number>();
  const drafts = descriptors.flatMap((descriptor) => {
    if (
      hasSyntaxProblem(descriptor.node) ||
      hasSyntaxProblem(descriptor.rangeNode) ||
      (descriptor.scopeNode !== undefined && hasSyntaxProblem(descriptor.scopeNode))
    ) return [];
    const signatureDiscriminator = signatureFor(source, descriptor.node);
    const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const startByte = startByteFor(descriptor.rangeNode, offsets);
    const endByte = offsets.byteOffsetAtUtf16(descriptor.rangeNode.endIndex);
    const declaration: StructuredDeclaration = {
      symbolId: createSymbolId({
        filePath: source.filePath,
        qualifiedName: descriptor.qualifiedName,
        kind: descriptor.kind,
        signatureDiscriminator,
        occurrence,
      }),
      qualifiedName: descriptor.qualifiedName,
      kind: descriptor.kind,
      signatureDiscriminator,
      position: positionFor(descriptor.rangeNode),
      name: descriptor.name,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      languageId: source.language,
      isExact: true,
      rawSource: decodeUtf8(source.bytes.subarray(startByte, endByte)),
    };
    return [{ descriptor, declaration }];
  });
  const symbolByKey = new Map(drafts.map(({ descriptor, declaration }) => [descriptor.declarationKey, declaration.symbolId]));
  return drafts.map(({ descriptor, declaration }) => {
    const parentSymbolId = descriptor.ownerKey === undefined ? undefined : symbolByKey.get(descriptor.ownerKey);
    return parentSymbolId === undefined ? declaration : { ...declaration, parentSymbolId };
  });
};

export class CppStructuredParser implements StructuredLanguageParser {
  constructor(private readonly runtime: CppTreeSitterRuntime) {}

  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    if (!source.bytes) {
      return {
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [],
        failure: { reasonCode: 'invariant_violation', message: 'C++ structured parsing requires source bytes.' },
      };
    }
    const parser = new this.runtime.Parser();
    parser.setLanguage(this.runtime.Cpp);
    const root = parser.parse(source.text).rootNode;
    let offsets: ReturnType<typeof createUtf8OffsetTable>;
    try {
      offsets = createUtf8OffsetTable(source.text, source.bytes);
    } catch (error) {
      if (error instanceof Utf8SourceError) return failedStructuredSource(error);
      throw error;
    }
    const diagnostics = diagnosticsFor(root);
    const declarations = declarationsWithIds(source, declarationsFor(root), offsets);
    const imports = importsFor(source, root, offsets);
    const generation = generationFor(source, diagnostics);
    return diagnostics.length === 0
      ? { status: 'ok', retrievability: 'exact', declarations, imports, generation }
      : {
          status: 'degraded',
          retrievability: 'partial',
          declarations,
          imports,
          generation,
          failure: { reasonCode: 'parse_error', message: 'C++ parse diagnostics were reported.' },
        };
  }
}
```

`generationFor` uses `parserId: 'cpp'`, grammar version `0.23.4`, and source
hash. Missing bytes return a degraded invariant result; invalid UTF-8 or a
tree-sitter load failure returns a failed result to the structured path.

`src/plugins/languages/cpp.ts`:

```typescript
import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile } from '../../types/index.js';
import type { StructuredLanguageParser, StructuredSource } from '../../structured/contracts.js';
import { decodeUtf8 } from '../../structured/hash.js';
import { CppStructuredParser, type CppTreeSitterRuntime } from './cpp-structured.js';

const textEncoder = new TextEncoder();

const sourceFor = (file: FileToChunk): StructuredSource => ({
  filePath: file.filePath,
  language: file.language,
  bytes: file.bytes ?? textEncoder.encode(file.content),
  text: file.content,
});

const loadTreeSitter = async (): Promise<CppTreeSitterRuntime> => {
  const [parser, cpp] = await Promise.all([import('tree-sitter'), import('tree-sitter-cpp')]);
  return { Parser: parser.default, Cpp: cpp.default };
};

const projectLegacyResult = (
  result: Extract<Awaited<ReturnType<StructuredLanguageParser['parseStructured']>>, { status: 'ok' | 'degraded' }>,
  source: StructuredSource,
): ParsedSourceFile => {
  const declarations = result.declarations.map(({ kind, name, position, rawSource }): ParsedDeclaration => ({
    type: kind,
    name,
    startLine: position.startLine,
    endLine: position.endLine,
    content: rawSource ?? '',
  }));
  const ranges = [...new Map(result.imports.map((item) => [`${item.startByte}:${item.endByte}`, item])).values()]
    .toSorted((left, right) => left.startByte - right.startByte);
  for (const item of ranges) {
    declarations.push({
      type: 'import',
      name: 'imports',
      startLine: item.position.startLine,
      endLine: item.position.endLine,
      content: decodeUtf8(source.bytes.subarray(item.startByte, item.endByte)),
    });
  }
  return {
    rootType: 'translation_unit',
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};

export class CppLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'cpp';
  readonly fileExtensions = ['.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    return new CppStructuredParser(await loadTreeSitter());
  }

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    const structured = await this.createStructuredParser();
    return {
      parse: async (file) => {
        const source = sourceFor(file);
        const result = await structured.parseStructured(source);
        if (result.status !== 'ok' && result.status !== 'degraded') throw new Error(result.failure.message);
        return projectLegacyResult(result, source);
      },
    };
  }
}
```

`projectLegacyResult` throws on failed/unsupported structured results so the
existing chunker fixed-line fallback remains responsible for normal vectors.
The structured path still receives the load failure as `parse-failed`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/structured/cpp-parser.test.ts -v
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/languages/cpp*.ts tests/unit/structured/cpp-parser.test.ts tests/fixtures/structured/cpp/
git commit -m "feat(structured): add C++ structured parser"
```

---

## Task 7: Python `.pyi` テスト

**Files:**
- Create: `tests/unit/structured/python-pyi-parser.test.ts`
- Create: `tests/fixtures/structured/python/exactness.pyi`
- Create: `tests/fixtures/structured/python/partial.pyi`

**Interfaces:**
- Consumes: 既存 `PythonLanguagePlugin` / `PythonStructuredParser`
- Produces: `.pyi` ファイルが `.py` と同じパーサで構造化されることのテスト証拠

- [ ] **Step 1: Add characterization fixtures and regression test**

`tests/fixtures/structured/python/exactness.pyi`:

```python
from typing import Protocol

class Drawable(Protocol):
    def draw(self) -> None: ...

def render(items: list[Drawable]) -> None: ...
```

`tests/fixtures/structured/python/partial.pyi`:

```python
def good() -> None: ...
def bad(:
```

`tests/unit/structured/python-pyi-parser.test.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PythonLanguagePlugin } from '../../../src/plugins/languages/python.js';
import { decodeUtf8 } from '../../../src/structured/hash.js';

const fixturePath = (name: string): string => path.join('tests', 'fixtures', 'structured', 'python', name);

const parsePyiFixture = async (name: string) => {
  const filePath = fixturePath(name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new PythonLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'python', bytes, text });
  return { bytes, result, text };
};

describe('Python stub structured parser', () => {
  it('parses .pyi with class, method, and function declarations', async () => {
    const { result } = await parsePyiFixture('exactness.pyi');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));
    expect(byName.get('Drawable')?.kind).toBe('class');
    expect(byName.get('Drawable.draw')?.kind).toBe('method');
    expect(byName.get('render')?.kind).toBe('function');
  });

  it('keeps valid declarations when a later declaration is malformed', async () => {
    const { result } = await parsePyiFixture('partial.pyi');
    expect(result.status).toBe('degraded');
    expect(result.declarations.find((d) => d.qualifiedName === 'good')).toBeDefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'bad')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the characterization test**

```bash
npx vitest run tests/unit/structured/python-pyi-parser.test.ts -v
```

Expected: PASS（Task 1で`.pyi`ルーティングを追加済みで、既存parserの挙動を確認する）

このTaskは既存Python parserの互換性を固定するcharacterization/regression
testであり、production変更前のREDを要求しない。意図的にproduction codeを
壊してREDを作ってはならない。


- [ ] **Step 3: Commit**

```bash
git add tests/unit/structured/python-pyi-parser.test.ts tests/fixtures/structured/python/exactness.pyi tests/fixtures/structured/python/partial.pyi
git commit -m "test(structured): add Python .pyi structured parser coverage"
```

---

## Task 8: プラグインレジストリ登録とルーティングテスト

**Files:**
- Modify: `src/server/factory.ts:604-606`
- Modify: `tests/unit/server/factory.test.ts`
- Create: `tests/unit/plugins/languages/rust.test.ts`
- Create: `tests/unit/plugins/languages/java.test.ts`
- Create: `tests/unit/plugins/languages/csharp.test.ts`
- Create: `tests/unit/plugins/languages/c.test.ts`
- Create: `tests/unit/plugins/languages/cpp.test.ts`

**Interfaces:**
- Consumes: すべての新言語プラグイン
- Produces: `NexusServerFactory.setupPluginRegistry` で新プラグインが登録される

- [ ] **Step 1: Write failing tests**

`tests/unit/server/factory.test.ts` の既存 `FactoryInternals` seam を使い、
production factoryが生成したregistryを直接検証する。テストでpluginを手動登録してはならない。

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/index.js';
import { NexusServerFactory } from '../../../src/server/factory.js';
import type { Config } from '../../../src/types/index.js';
import type { PluginRegistry } from '../../../src/plugins/registry.js';

interface FactoryInternals {
  setupPluginRegistry(config: Config): PluginRegistry;
}

const internals = NexusServerFactory as unknown as FactoryInternals;

describe('NexusServerFactory language registration', () => {
  it('routes every supported extension through the factory-created registry', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-routing-'));
    try {
      const config = await loadConfig({
        projectRoot,
        env: {
          NEXUS_EMBEDDING_PROVIDER: 'bedrock',
          NEXUS_EMBEDDING_DIMENSIONS: '1024',
          NEXUS_EMBEDDING_REGION: 'us-east-1',
        },
      });
      const registry = internals.setupPluginRegistry(config);
      const routes: ReadonlyArray<readonly [string, string]> = [
        ['.pyi', 'python'],
        ['.rs', 'rust'],
        ['.java', 'java'],
        ['.cs', 'csharp'],
        ['.c', 'c'],
        ['.h', 'cpp'],
        ['.cc', 'cpp'],
        ['.cpp', 'cpp'],
        ['.cxx', 'cpp'],
        ['.hh', 'cpp'],
        ['.hpp', 'cpp'],
        ['.hxx', 'cpp'],
      ];
      for (const [extension, languageId] of routes) {
        expect(registry.getLanguagePlugin(`src/example${extension}`)?.languageId).toBe(languageId);
      }
      expect(registry.getLanguagePlugin('src/example.txt')).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
```

各言語pluginの`supports()`単体テストは新規ファイルで行うが、factory登録の
証拠は上記の`tests/unit/server/factory.test.ts`だけで満たす。ルーティング
テストで全pluginを手動登録する実装は禁止する。

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/unit/server/factory.test.ts tests/unit/plugins/languages/rust.test.ts -v
```

Expected: FAIL（factoryが新pluginを未登録、または新plugin moduleが未定義）

- [ ] **Step 3: Modify factory registration**

`src/server/factory.ts` の `setupPluginRegistry` を編集する。既存の3つの
`registerLanguage`呼び出しの直後に、以下の5つを追加する。

```typescript
import { RustLanguagePlugin } from '../plugins/languages/rust.js';
import { JavaLanguagePlugin } from '../plugins/languages/java.js';
import { CSharpLanguagePlugin } from '../plugins/languages/csharp.js';
import { CLanguagePlugin } from '../plugins/languages/c.js';
import { CppLanguagePlugin } from '../plugins/languages/cpp.js';

    registry.registerLanguage(new RustLanguagePlugin());
    registry.registerLanguage(new JavaLanguagePlugin());
    registry.registerLanguage(new CSharpLanguagePlugin());
    registry.registerLanguage(new CLanguagePlugin());
    registry.registerLanguage(new CppLanguagePlugin());
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/server/factory.test.ts tests/unit/plugins/languages/rust.test.ts tests/unit/plugins/languages/java.test.ts tests/unit/plugins/languages/csharp.test.ts tests/unit/plugins/languages/c.test.ts tests/unit/plugins/languages/cpp.test.ts -v
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/factory.ts tests/unit/server/factory.test.ts tests/unit/plugins/languages/rust.test.ts tests/unit/plugins/languages/java.test.ts tests/unit/plugins/languages/csharp.test.ts tests/unit/plugins/languages/c.test.ts tests/unit/plugins/languages/cpp.test.ts
git commit -m "feat(plugins): register new language plugins and add routing tests"
```

---

## Task 9: Pipeline の import-only ファイル修正

**Files:**
- Modify: `src/indexer/pipeline.ts:465-467`
- Test: `tests/unit/indexer/pipeline-structured-imports.test.ts`
- Extend: `tests/unit/indexer/pipeline-structured-lifecycle.test.ts`

**Interfaces:**
- Consumes: `readStructuredFile` からの `StructuredParseResult`
- Produces: `status === 'ok' && declarations.length === 0 && imports.length > 0` の場合 `kind: 'work'` を返す

- [ ] **Step 1: Write failing test**

`tests/unit/indexer/pipeline-structured-imports.test.ts` must exercise the
public pipeline event/rebuild paths. The test may use the existing
`createStructuredCoordinatorFixture` and `TestEmbeddingProvider` helpers, but
must not add a new storage or pipeline test framework.

```typescript
import { describe, expect, it } from 'vitest';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { CppLanguagePlugin } from '../../../src/plugins/languages/cpp.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import { Chunker } from '../../../src/indexer/chunker.js';
import { sha256Hex } from '../../../src/structured/hash.js';
import { createStructuredCoordinatorFixture } from '../../shared/structured-test-helpers.js';

const eventFor = (type: 'added' | 'modified', filePath: string, content: string) => ({
  type,
  filePath,
  contentHash: sha256Hex(new TextEncoder().encode(content)),
  detectedAt: new Date().toISOString(),
} as const);

const createCppPipeline = async () => {
  const fixture = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });
  fixture.pluginRegistry.registerLanguage(new CppLanguagePlugin());
  const pipeline = new IndexPipeline({
    metadataStore: fixture.metadataStore,
    vectorStore: fixture.vectorStore,
    chunker: new Chunker(fixture.pluginRegistry),
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: fixture.pluginRegistry,
    structuredIndexCoordinator: fixture.coordinator,
  });
  return { ...fixture, pipeline };
};

const importFor = (content: string) => ({
  id: 'import_v1_test_stdio',
  moduleSpecifier: 'stdio.h',
  startByte: 0,
  endByte: Buffer.byteLength(content, 'utf8'),
  sourceHash: sha256Hex(new TextEncoder().encode(content)),
  completeness: 'complete' as const,
  position: { startLine: 1, startColumn: 0, endLine: 1, endColumn: content.length },
});

describe('IndexPipeline structured import-only handling', () => {
  it('persists an ok import-only file through incremental processing', async () => {
    const { metadataStore, pipeline } = await createCppPipeline();
    const content = '#include <stdio.h>\n';
    await pipeline.processEvents([eventFor('added', 'header.h', content)], async () => content);

    await expect(metadataStore.resolveFile('header.h')).resolves.toMatchObject({ kind: 'active' });
    expect(metadataStore.getActiveImportsForFile('header.h')).toEqual(
      expect.arrayContaining([expect.objectContaining({ moduleSpecifier: 'stdio.h', completeness: 'complete' })]),
    );
  });

  it('routes degraded import-only incremental updates to DLQ without replacing active state', async () => {
    const { metadataStore, vectorStore, pipeline, pluginRegistry } = await createCppPipeline();
    const filePath = 'header.h';
    const initial = '#include <stdio.h>\n';
    const broken = '#include <stdio.h>\n// degraded\n';
    await pipeline.processEvents([eventFor('added', filePath, initial)], async () => initial);
    const activeBefore = await metadataStore.resolveFile(filePath);
    const vectorsBefore = await vectorStore.search(new Array(64).fill(0), 100, { filePathPrefix: filePath });
    const plugin = pluginRegistry.getLanguagePlugin(filePath);
    if (plugin?.createStructuredParser === undefined) throw new Error('C++ structured parser is unavailable');
    plugin.createStructuredParser = async () => ({
      parseStructured: async () => ({
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [importFor(broken)],
        failure: { reasonCode: 'parse_error', message: 'degraded import-only fixture' },
      }),
    });

    await pipeline.processEvents([eventFor('modified', filePath, broken)], async () => broken);
    await expect(metadataStore.getDeadLetterEntries()).resolves.toHaveLength(1);
    await expect(metadataStore.resolveFile(filePath)).resolves.toEqual(activeBefore);
    const vectorsAfter = await vectorStore.search(new Array(64).fill(0), 100, { filePathPrefix: filePath });
    expect(vectorsAfter.map((result) => result.chunk.id)).toEqual(vectorsBefore.map((result) => result.chunk.id));
  });

  it('aborts a degraded import-only full rebuild and preserves active state', async () => {
    const { metadataStore, vectorStore, pipeline, pluginRegistry } = await createCppPipeline();
    const filePath = 'header.h';
    const initial = '#include <stdio.h>\n';
    const broken = '#include <stdio.h>\n// degraded rebuild\n';
    await pipeline.processEvents([eventFor('added', filePath, initial)], async () => initial);
    const activeBefore = await metadataStore.resolveFile(filePath);
    const vectorsBefore = await vectorStore.search(new Array(64).fill(0), 100, { filePathPrefix: filePath });
    const plugin = pluginRegistry.getLanguagePlugin(filePath);
    if (plugin?.createStructuredParser === undefined) throw new Error('C++ structured parser is unavailable');
    plugin.createStructuredParser = async () => ({
      parseStructured: async () => ({
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [importFor(broken)],
        failure: { reasonCode: 'parse_error', message: 'degraded import-only rebuild fixture' },
      }),
    });

    await expect(pipeline.reindex(
      async () => [eventFor('modified', filePath, broken)],
      async () => broken,
      true,
    )).rejects.toThrow(/Structured full rebuild aborted/);
    await expect(metadataStore.resolveFile(filePath)).resolves.toEqual(activeBefore);
    const vectorsAfter = await vectorStore.search(new Array(64).fill(0), 100, { filePathPrefix: filePath });
    expect(vectorsAfter.map((result) => result.chunk.id)).toEqual(vectorsBefore.map((result) => result.chunk.id));
  });
});
```

The degraded parser fixture must keep a non-empty import list even though the
pipeline treats `declarations.length === 0` as `parse-failed`. The assertions
must cover the DLQ entry, unchanged active generation, and unchanged normal
vector rows rather than only the private return kind.

`getActiveImportsForFile` in this test is the existing concrete helper on
`InMemoryMetadataStore`; it is not added to `IMetadataStore` or the production
catalog interface. The test must not introduce a production storage API solely
to observe the persisted import records.

The existing `tests/unit/indexer/pipeline-structured-lifecycle.test.ts` is the
fourth regression case. Keep its incremental failure/recovery and full-rebuild
abort coverage, and explicitly retain the active generation and old vector row
after a structured failure. Do not introduce a new mock storage framework.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/indexer/pipeline-structured-imports.test.ts -v
```

Expected: FAIL（現行条件ではimport-only結果が`retire`になり、統合assertionも満たされない）

- [ ] **Step 3: Write minimal implementation**

`src/indexer/pipeline.ts` の `readStructuredFile` を編集：

```typescript
      if (result.status === 'ok' && result.declarations.length === 0) {
        return { kind: 'retire' };
      }
```

を以下に変更：

```typescript
      if (result.status === 'ok' && result.declarations.length === 0 && result.imports.length === 0) {
        return { kind: 'retire' };
      }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/indexer/pipeline-structured-imports.test.ts -v
npx vitest run tests/unit/indexer/pipeline-structured-lifecycle.test.ts -v
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/pipeline.ts tests/unit/indexer/pipeline-structured-imports.test.ts tests/unit/indexer/pipeline-structured-lifecycle.test.ts
git commit -m "fix(pipeline): keep ok import-only structured files as work"
```

---

## Task 10: 言語ルーティング確認（Task 8に統合）

独立したpipeline routing testは作成しない。`IndexPipeline.detectLanguage()`
は既存の`PluginRegistry.getLanguagePlugin(filePath)?.languageId`委譲であり、
拡張子とfactory登録の責務はTask 8のproduction factory-created registry testで
同時に検証する。Task 8のroute tableには`.pyi`、`.rs`、`.java`、`.cs`、`.c`、
`.h`、`.cc`、`.cpp`、`.cxx`、`.hh`、`.hpp`、`.hxx`と未知の`.txt`を含める。

このTaskにはproduction変更、個別fixture、failing test、RED期待、commitを
追加しない。`detectLanguage`へ拡張子のhard-codeを追加してはならない。

---

## Task 11: ドキュメント更新

**Files:**
- Modify: `docs/structured-index.md`
- Modify: `docs/mcp-tools.md`

**Interfaces:**
- Consumes: 新しい言語セットと SymbolKind
- Produces: ユーザー向けドキュメント更新

- [ ] **Step 1: Write failing doc snapshot test**

`tests/unit/docs/structured-index-docs.test.ts`（新規）：

```typescript
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('structured-index documentation', () => {
  it('lists all new supported extensions', async () => {
    const content = await readFile('docs/structured-index.md', 'utf8');
    for (const ext of ['.rs', '.java', '.cs', '.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx', '.pyi']) {
      expect(content).toContain(ext);
    }
    expect(content).toContain('C++');
    expect(content).toContain('`nexus --reindex --full`');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/docs/structured-index-docs.test.ts -v
```

Expected: FAIL

- [ ] **Step 3: Update documentation**

`docs/structured-index.md` の「Supported languages and extensions」テーブルを：

```markdown
| Language family         | Structured extensions                                        |
| ----------------------- | ------------------------------------------------------------ |
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` |
| Python                  | `.py`, `.pyi`                                                |
| Go                      | `.go`                                                        |
| Rust                    | `.rs`                                                        |
| Java                    | `.java`                                                      |
| C#                      | `.cs`                                                        |
| C                       | `.c`                                                         |
| C++                     | `.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`           |
```

に更新。

「Structured index vs vector index」セクションの例から `.rs` を削除（もはや unsupported ではない）。

「Known limitations」セクションの後に追加：

```markdown
## Upgrading to a new language set

Files that already existed in a workspace before a new language is added and
have not changed since are not reprocessed automatically. To backfill existing
unchanged files with newly supported extensions, run:

```bash
nexus --reindex --full
```
```

`.h` を C++ としてパースすること、C/C++ はソースのみの構文解析でコンパイルセマンティクスは解決しないことを Known limitations に追加。

`docs/mcp-tools.md` の `get_file_outline` 周辺の `SymbolKind` 言及を更新。既存セクション「`kind`」に以下を追加：

```markdown
Additional language-specific kinds include `struct`, `trait`, `impl`, `record`, and `field`.
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/docs/structured-index-docs.test.ts -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/structured-index.md docs/mcp-tools.md tests/unit/docs/structured-index-docs.test.ts
git commit -m "docs: document new structured languages, extensions, and backfill procedure"
```

---

## Task 12: 全体統合・回帰テスト

**Files:**
- すべての変更ファイル

**Interfaces:**
- Consumes: 実装済み全コンポーネント
- Produces: グリーンパイプライン

- [ ] **Step 1: Validate the clean dependency install**

```bash
npm ci
```

Expected: PASS; `package-lock.json` satisfies `package.json` without modifying
the lockfile.

- [ ] **Step 2: Run full test suite**

```bash
npm run test
```

Expected: PASS（全テスト）

- [ ] **Step 3: Run lint and type check**

```bash
npm run lint
npx tsc --noEmit
```

Expected: PASS / no errors

- [ ] **Step 4: Run build**

```bash
npm run build
```

Expected: PASS

- [ ] **Step 5: Run license check**

```bash
npm run license:check
```

Expected: PASS

完了条件は次の6コマンドすべてが終了コード0で完了すること：
`npm ci`、`npm run test`、`npm run lint`、`npx tsc --noEmit`、
`npm run build`、`npm run license:check`。

- [ ] **Step 6: Commit any final fixes**

```bash
git add package.json package-lock.json src/types/index.ts src/plugins/languages src/server/factory.ts src/indexer/pipeline.ts docs/mcp-tools.md docs/structured-index.md tests/unit tests/fixtures
git commit -m "chore: address integration test findings"
```

---

## Self-Review

### 1. Spec coverage

| 設計書セクション | 実装タスク |
| --- | --- |
| §1 Parser framework: Tree-sitter | Task 1, 2, 3, 4, 5, 6（依存関係追加 + 各言語パーサ） |
| §2 Language plugin registration | Task 8（factory.ts 登録） |
| §3 Extension routing | Task 1（.pyi）、Task 2-6（各拡張子）、Task 8（factory-created registry） |
| §4 SymbolKind extension | Task 1（src/types/index.ts） |
| §5 Language-specific declaration mapping | Task 2-6（各言語 declarations、Java package selector、C++ class/struct member scope） |
| §6 Container and parent-child handling | Task 2-6（Java logical file scope、C++ typeName、declarationKey / ownerKey / parentSymbolId） |
| §7 Stable symbol identity | Task 2-6（createSymbolId 使用、occurrence カウント） |
| §8 Import / include / use / using | Task 2-6（各言語 imports モジュール） |
| §9 Partial parse and fallback | Task 2-6（hasSyntaxProblem スキップ）、Task 9（import-only 修正） |
| §10 Incremental integration | Task 9（incremental/full-rebuild lifecycle）、Task 11（バックフィル手順ドキュメント） |
| テスト戦略 | Task 2-9, 11-12（Task 10はTask 8へ統合） |
| Acceptance Criteria | Task 1-12 |

### 2. Placeholder scan

計画内に曖昧なTODOや未定義のproduction implementation委譲を残さない。
Task 3〜6は5つのproduction fileごとにdescriptor型、
recursive traversal、owner key、import mapping、parse result、plugin fallbackを
明記し、Step 4で指定fixtureをparseしてnode typeを確認する。

### 3. Type consistency

- `SymbolKind` 追加値は Task 1 で一括定義。各言語パーサはそれらの値のみを返す。
- `qualifiedName` は全言語で `.` セパレタ（Rust も `module.Trait`, `Type.method`）。
- Rust `impl` methodは`outer.Point.new`であり、`outer.Point.impl.new`ではない。
- `declarationKey`/`ownerKey`はfile-local node identityで解決し、bare nameをowner lookupに使わない。
- Java package は `nameFor()` の direct named child fallback で
  `scoped_identifier` を取得し、package declaration と top-level declaration の
  logical file scope を分離する。
- C++ class/struct member scope は共通の `typeName` を使い、両方の
  constructor/method を同じ selector で抽出する。member variable は
  引き続き対象外とする。
- `LanguagePlugin.languageId` は設計書 §3 と一致: `rust`, `java`, `csharp`, `c`, `cpp`。
- `fileExtensions` は設計書 §3 と一致。
- `import` レコードの `completeness` はdirect binding/concrete includeを`complete`、wildcard/static/unresolved/syntax-diagnosticを`partial`とする。Rust direct `use`は`bindingName`を抽出する。

### 4. Bidirectional traceability

| Design requirement | Plan evidence |
| --- | --- |
| grammar dependencies 5件 | Task 1 package/lockfile + Task 12 `npm ci` |
| `.pyi` routing/reuse | Task 1 + Task 7 |
| Rust §5 declarations | Task 2 fixture/assertions/selector |
| Java §5 declarations | Task 3 fixture/assertions/selector |
| Java package → namespace | Task 3 package descriptor/test |
| Java package logical file scope | Task 3 `baseScope` |
| Java package-less file | Task 3 `PackageLess.java` test |
| Java package `parentSymbolId` | Task 3 exactness assertion |
| C# §5 declarations | Task 4 fixture/assertions/selector |
| C §5 declarations | Task 5 fixture/assertions/selector |
| C++ struct | Task 6 `Point`/`StructWidget` tests |
| C++ class | Task 6 `Widget`/`HeaderOnly` tests |
| C++ class constructor/method | Task 6 `typeName` selector + tests |
| C++ struct constructor/method | Task 6 `typeName` selector + tests |
| canonical `qualifiedName` | Design §6 + Task 2-6 descriptor code/assertions |
| `parentSymbolId` | Task 2-6 `declarationKey`/`ownerKey` materialization |
| lexical `ownerKey` | Task 2-6 direct ownerKey propagation |
| broken container non-flattening | Task 2-6 guards + partial tests |
| stable identity | Task 2-6 `createSymbolId`/signature/occurrence |
| StructuredImport mapping/completeness | Design §8 + Task 2-7 import assertions |
| factory registration/routing | Task 8 `FactoryInternals` registry test |
| ok import-only persistence | Task 9 incremental `processEvents` test |
| degraded incremental DLQ | Task 9 degraded incremental test + lifecycle regression |
| degraded full rebuild abort | Task 9 degraded rebuild test + lifecycle regression |
| active generation preservation | Task 9 state assertions + existing lifecycle test |
| normal vectors unchanged on failure | Task 9 vector row assertions |
| backfill and complete documentation | Task 11 |
| all quality gates | Task 12 Steps 1-5 |

| Implementation task | Requirements it must leave proven |
| --- | --- |
| Task 1 | grammar versions, additive `SymbolKind`, `.pyi` routing |
| Task 2 | Rust declarations, recursive ownership, direct/wildcard `use`, fallback |
| Task 3 | Java declarations, package selector/scope, imports, fallback |
| Task 4 | C# declarations, block/file-scoped namespace, properties, using completeness, fallback |
| Task 5 | C functions/structs/enums, include records, C grammar load/fallback |
| Task 6 | C++ namespaces/types/functions, class/struct members, includes |
| Task 7 | existing Python `.pyi` parser behavior |
| Task 8 | factory-created production registry and extension routing |
| Task 9 | catalog persistence and fail-closed incremental/full-rebuild lifecycle |
| Task 10 | no independent implementation; routing remains owned by Task 8 |
| Task 11 | supported-extension and backfill documentation |
| Task 12 | clean install, tests, lint/typecheck, build, license gate |

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-09-structured-index-language-extension.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints for review

**Which approach?**
