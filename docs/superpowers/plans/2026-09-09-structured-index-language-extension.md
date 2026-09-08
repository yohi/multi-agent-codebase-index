# Nexus 構造化インデックス対応言語・拡張子拡張 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rust (`.rs`)、Java (`.java`)、C# (`.cs`)、C (`.c`)、C++ (`.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`)、および Python type stubs (`.pyi`) を、既存の構造化インデックスと MCP 取得ツールに統合し、新しい `SymbolKind` を追加する。

**Architecture:** すべての新言語は既存の Python / Go と同じ `tree-sitter` 基盤を使う。各言語は `LanguagePlugin` と `StructuredLanguageParser` を実装し、宣言・インポート・補助関数を分離した 2〜5 ファイルで構成する。`src/server/factory.ts` に登録し、`SymbolKind` を拡張、`src/indexer/pipeline.ts` の import-only ファイルの扱いを修正する。

**Tech Stack:** TypeScript、Node.js >=24、tree-sitter 0.25.1、新規 grammars（`tree-sitter-rust@0.24.0`、`tree-sitter-java@0.23.5`、`tree-sitter-c-sharp@0.23.5`、`tree-sitter-cpp@0.23.4`、`tree-sitter-c@0.23.6`）、vitest。

## Global Constraints

- Node.js >=24.0.0
- `tree-sitter` 0.25.1 ベース
- 新規 grammar package: `tree-sitter-rust@0.24.0`、`tree-sitter-java@0.23.5`、`tree-sitter-c-sharp@0.23.5`、`tree-sitter-cpp@0.23.4`、`tree-sitter-c@0.23.6`
- C / C++ は別プラグインとして実装する（`.h` は C++ として扱う）
- `.h` は C++ として明示的に扱う
- `.pyi` は既存 `tree-sitter-python` grammar を再利用する
- `SymbolKind` 追加は既存値を変更しない加算的拡張のみ
- `qualifiedName` はカタログ全体で `.` セパレータを使用する（Rust も `module.Trait`、`Type.method`）
- 構造化パース失敗は fail-closed: 増分更新では DLQ へ、フルリビルドでは中止
- `npm ci`、`npm run build`、`npm run lint`、`npx tsc --noEmit`、`npm run license:check`、`npm run test` がすべて通ること
- ロックファイルは `npm install` で再生成し、手編集禁止

---

## File Structure

### 変更ファイル

| ファイル | 責務 |
| --- | --- |
| `package.json` / `package-lock.json` | 4 つの新 tree-sitter grammar dependency を追加 |
| `src/types/index.ts` | `SymbolKind` に `struct`, `trait`, `impl`, `record`, `field` を追加 |
| `src/plugins/languages/python.ts` | `.pyi` を `fileExtensions` に追加 |
| `src/server/factory.ts` | 新しい 7 言語プラグインを `setupPluginRegistry` に登録 |
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
| `tests/unit/plugins/registry.test.ts` | 新拡張子のルーティングテスト（既存ファイルに追加） |
| `tests/unit/indexer/pipeline-structured-imports.test.ts` | import-only ファイル・degraded import-only ファイルのパイプライン挙動テスト |
| `tests/fixtures/structured/rust/exactness.rs` | Rust 正常 fixture |
| `tests/fixtures/structured/rust/partial.rs` | Rust 部分破損 fixture |
| `tests/fixtures/structured/java/Exactness.java` | Java 正常 fixture |
| `tests/fixtures/structured/java/Partial.java` | Java 部分破損 fixture |
| `tests/fixtures/structured/csharp/Exactness.cs` | C# 正常 fixture |
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

    impl Point {
        pub fn new(x: f64, y: f64) -> Self {
            Point { x, y }
        }
    }

    pub trait Drawable {
        fn draw(&self);
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
    // 意図的な構文エラー: 閉じ括弧なし
```

`tests/unit/structured/rust-parser.test.ts`（抜粋、全体はファイルに展開）：

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
  it('extracts module, struct, impl, trait, function, and method with stable symbolIds', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));

    expect(byName.get('outer')?.kind).toBe('namespace');
    expect(byName.get('outer.Point')?.kind).toBe('struct');
    expect(byName.get('outer.Point.impl.new')?.kind).toBe('method');
    expect(byName.get('outer.Drawable')?.kind).toBe('trait');
    expect(byName.get('top_level')?.kind).toBe('function');
    expect(byName.get('outer.Point.impl.new')?.parentSymbolId).toBe(byName.get('outer.Point')?.symbolId);
    expect(byName.get('outer.Point')?.symbolId).toMatch(/^symbol_v1_/);
  });

  it('uses dot separator in qualifiedName', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const names = result.declarations.map((d) => d.qualifiedName);
    expect(names).toContain('outer.Point');
    expect(names).toContain('outer.Point.impl.new');
    expect(names).toContain('outer.Drawable');
  });

  it('extracts use imports and marks wildcard imports partial', async () => {
    const { result } = await parseRustFixture('exactness.rs');
    const fileImport = result.imports.find((i) => i.moduleSpecifier === 'std::fs::File');
    const wildcard = result.imports.find((i) => i.moduleSpecifier === 'std::io' && i.bindingName === undefined);

    expect(fileImport?.bindingName).toBe('File');
    expect(fileImport?.completeness).toBe('partial');
    expect(wildcard?.completeness).toBe('partial');
  });

  it('keeps valid declarations when a later declaration is malformed', async () => {
    const { result } = await parseRustFixture('partial.rs');

    expect(result.status).toBe('degraded');
    expect(result.retrievability).toBe('partial');
    expect(result.declarations.find((d) => d.qualifiedName === 'Good')).toBeDefined();
    expect(result.declarations.find((d) => d.qualifiedName === 'Bad')).toBeUndefined();
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

export interface DeclarationDescriptor {
  readonly node: Parser.SyntaxNode;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly ownerName?: string;
}

const nameNodeText = (node: Parser.SyntaxNode): string | undefined => {
  const name = node.childForFieldName('name');
  return name?.text;
};

const bodyNode = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined =>
  node.children.find((child) => child.type === 'declaration_list' || child.type === 'block');

const kindForType = (node: Parser.SyntaxNode): SymbolKind => {
  if (node.type === 'enum') return 'enum';
  if (node.type === 'trait_item') return 'trait';
  return 'struct';
};

const scopedChildDeclarations = (
  parentNode: Parser.SyntaxNode,
  parentQualifiedName: string,
  parentName: string,
): readonly DeclarationDescriptor[] => {
  const body = bodyNode(parentNode);
  if (!body) return [];
  const descriptors: DeclarationDescriptor[] = [];
  for (const child of body.namedChildren) {
    const descriptor = declarationFor(child);
    if (!descriptor) continue;
    descriptors.push({
      ...descriptor,
      qualifiedName: `${parentQualifiedName}.${descriptor.name}`,
      ownerName: parentName,
    });
  }
  return descriptors;
};

const declarationFor = (node: Parser.SyntaxNode): DeclarationDescriptor | undefined => {
  if (node.type === 'mod_item') {
    const name = nameNodeText(node);
    if (!name) return undefined;
    return { node, kind: 'namespace', name, qualifiedName: name };
  }
  if (node.type === 'struct_item' || node.type === 'enum_item' || node.type === 'trait_item') {
    const name = nameNodeText(node);
    if (!name) return undefined;
    return { node, kind: kindForType(node), name, qualifiedName: name };
  }
  if (node.type === 'impl_item') {
    const typeNode = node.childForFieldName('type') ?? node.children.find((c) => c.type === 'type');
    const traitNode = node.childForFieldName('trait');
    const name = typeNode?.text;
    if (!name) return undefined;
    const qualifiedName = traitNode ? `${traitNode.text}.${name}` : `${name}.impl`;
    return { node, kind: 'impl', name, qualifiedName };
  }
  if (node.type === 'function_item') {
    const name = nameNodeText(node);
    if (!name) return undefined;
    return { node, kind: 'function', name, qualifiedName: name };
  }
  return undefined;
};

const withNested = (descriptor: DeclarationDescriptor): readonly DeclarationDescriptor[] => {
  if (descriptor.kind === 'namespace' || descriptor.kind === 'impl') {
    return [descriptor, ...scopedChildDeclarations(descriptor.node, descriptor.qualifiedName, descriptor.name)];
  }
  return [descriptor];
};

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const result: DeclarationDescriptor[] = [];
  for (const child of root.namedChildren) {
    const descriptor = declarationFor(child);
    if (!descriptor) continue;
    result.push(...withNested(descriptor));
  }
  return result;
};
```

`src/plugins/languages/rust-structured-imports.ts`:

```typescript
import type Parser from 'tree-sitter';
import { createHash } from 'node:crypto';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './rust-structured-support.js';

const moduleSpecifiersFor = (node: Parser.SyntaxNode): readonly { specifier: string; bindingName?: string }[] => {
  if (node.type !== 'use_declaration') return [];
  const argument = node.childForFieldName('argument');
  if (!argument) return [];

  const recursive = (n: Parser.SyntaxNode, prefix: string): readonly { specifier: string; bindingName?: string }[] => {
    if (n.type === 'scoped_identifier' || n.type === 'identifier') {
      return [{ specifier: `${prefix}${n.text}`.replace(/^::/, '') }];
    }
    if (n.type === 'use_wildcard') {
      const scoped = n.children.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
      return [{ specifier: `${prefix}${scoped?.text ?? ''}`.replace(/^::/, ''), bindingName: undefined }];
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
      imports.push({
        id: `import_v1_${createHash('sha256').update(importKey, 'utf8').digest('base64url')}`,
        moduleSpecifier: binding.specifier,
        bindingName: binding.bindingName,
        startByte,
        endByte,
        sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
        completeness: 'partial',
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
  parserVersion: '0.25.0',
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
    const drafts: { declaration: StructuredDeclaration; ownerName?: string }[] = [];

    for (const descriptor of declarationsFor(root)) {
      if (hasSyntaxProblem(descriptor.node)) continue;
      const signatureDiscriminator = signatureFor(source, descriptor.node);
      const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      const startByte = findDeclarationStartByte(textLines, descriptor.node.startPosition.row + 1, offsets);
      const endByte = offsets.byteOffsetAtUtf16(descriptor.node.endIndex);
      drafts.push({
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
          position: positionFor(descriptor.node),
          name: descriptor.name,
          startByte,
          endByte,
          sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
          languageId: source.language,
          isExact: true,
          rawSource: decodeUtf8(source.bytes.subarray(startByte, endByte)),
        },
        ownerName: descriptor.ownerName,
      });
    }

    const ownerSymbols = new Map(
      drafts
        .filter(({ declaration }) => ['struct', 'trait', 'impl', 'namespace'].includes(declaration.kind))
        .map(({ declaration }) => [declaration.qualifiedName, declaration.symbolId]),
    );
    const declarations = drafts.map(({ declaration, ownerName }) => {
      const parentSymbolId = ownerName === undefined ? undefined : ownerSymbols.get(ownerName);
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
- Test fixtures: `tests/fixtures/structured/java/Exactness.java`, `tests/fixtures/structured/java/Partial.java`

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

public class Partial {
    public void good() {}
    public void bad( {
}
```

`tests/unit/structured/java-parser.test.ts`（抜粋）：

```typescript
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
    const { result } = await parseJavaFixture('Exactness.java');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));

    expect(byName.get('com.example')?.kind).toBe('namespace');
    expect(byName.get('com.example.Exactness')?.kind).toBe('class');
    expect(byName.get('com.example.Exactness.Point')?.kind).toBe('record');
    expect(byName.get('com.example.Exactness.Drawable')?.kind).toBe('interface');
    expect(byName.get('com.example.Exactness.Color')?.kind).toBe('enum');
    expect(byName.get('com.example.Exactness.field')?.kind).toBe('field');
    expect(byName.get('com.example.Exactness.Exactness')?.kind).toBe('constructor');
    expect(byName.get('com.example.Exactness.method')?.kind).toBe('method');
  });

  it('extracts imports and marks wildcard imports partial', async () => {
    const { result } = await parseJavaFixture('Exactness.java');
    const listImport = result.imports.find((i) => i.moduleSpecifier === 'java.util.List');
    const wildcard = result.imports.find((i) => i.moduleSpecifier === 'java.util');
    expect(listImport?.bindingName).toBe('List');
    expect(wildcard?.completeness).toBe('partial');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/structured/java-parser.test.ts -v
```

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Java 用の 5 ファイルを作成。Rust と同じパターンで、`DeclarationDescriptor`、tree-sitter-java AST selector、imports を実装。`package_declaration` を `namespace`、クラス内入れ子は `.` separator、`record_declaration` は `record`、`field_declaration` は `field`、メソッドは `method`、コンストラクタは `constructor`。実装時には fixture を tree-sitter で parse して node 名を確認し、`class_declaration`, `interface_declaration`, `enum_declaration`, `record_declaration`, `method_declaration`, `constructor_declaration`, `field_declaration`, `package_declaration` を使用する。

`src/plugins/languages/java.ts` は Rust と同じ構成で `languageId='java'`、`fileExtensions=['.java']` とする。

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
- Test fixtures: `tests/fixtures/structured/csharp/Exactness.cs`, `tests/fixtures/structured/csharp/Partial.cs`

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
namespace MyApp;
public class Partial {
    public void Good() {}
    public void Bad( {
}
```

テストは Java パーサーと同じ構成とする。期待:

- `MyApp` → `namespace`
- `MyApp.Exactness` → `class`
- `MyApp.Exactness.Point` → `struct`
- `MyApp.Exactness.IDrawable` → `interface`
- `MyApp.Exactness.Color` → `enum`
- `MyApp.Exactness.Person` → `record`
- `MyApp.Exactness.Exactness` → `constructor`
- `MyApp.Exactness.Method` → `method`
- `MyApp.Exactness.Point.X` → `property`
- `System` import → `moduleSpecifier: 'System', bindingName: undefined, completeness: partial`
- `System.Math` static import → `moduleSpecifier: 'System.Math', bindingName: undefined, completeness: partial`

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/structured/csharp-parser.test.ts -v
```

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

C# 用 5 ファイルを作成。tree-sitter-c-sharp grammar の node 名に合わせて selector を実装する。使用する node 名は `namespace_declaration`, `class_declaration`, `struct_declaration`, `interface_declaration`, `enum_declaration`, `record_declaration`, `method_declaration`, `constructor_declaration`, `property_declaration`, `using_directive` である。C# 名前空間なしトップレベル文には `file_scoped_namespace_declaration` も対応させる。

`src/plugins/languages/csharp.ts` は Rust と同じ構成で `languageId='csharp'`、`fileExtensions=['.cs']` とする。

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

`tests/unit/structured/c-parser.test.ts`（抜粋）:

```typescript
describe('C structured parser', () => {
  it('extracts function, struct, enum, and include imports', async () => {
    const { result } = await parseCFixture('exactness.c');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));

    expect(byName.get('Point')?.kind).toBe('struct');
    expect(byName.get('Color')?.kind).toBe('enum');
    expect(byName.get('top_level')?.kind).toBe('function');

    const stdio = result.imports.find((i) => i.moduleSpecifier === 'stdio.h');
    const local = result.imports.find((i) => i.moduleSpecifier === 'local.h');
    expect(stdio).toBeDefined();
    expect(local).toBeDefined();
    expect(stdio?.completeness).toBe('partial');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/structured/c-parser.test.ts -v
```

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

C 用 5 ファイルを作成。`tree-sitter-c` grammar を `language: 'c'` としてセットする。`function_definition` → `function`、`struct_specifier` → `struct`、`enum_specifier` → `enum`、`preproc_include` → import。struct/enum のタグ名は `type_identifier`、フィールド名は `field_identifier` から取得する。

`src/plugins/languages/c.ts` は Rust と同じ構成で `languageId='c'`、`fileExtensions=['.c']` とする。

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

    class Widget {
    public:
        Widget();
        void render();
    };

    enum class Color { Red, Green };

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
    void bad( {
}
```

`tests/unit/structured/cpp-parser.test.ts`（抜粋）:

```typescript
describe('C++ structured parser', () => {
  it('extracts namespace, function, struct, class, enum, constructor, method', async () => {
    const { result } = await parseCppFixture('exactness.cpp');
    const byName = new Map(result.declarations.map((d) => [d.qualifiedName, d]));

    expect(byName.get('app')?.kind).toBe('namespace');
    expect(byName.get('app.Point')?.kind).toBe('struct');
    expect(byName.get('app.Widget')?.kind).toBe('class');
    expect(byName.get('app.Widget.Widget')?.kind).toBe('constructor');
    expect(byName.get('app.Widget.render')?.kind).toBe('method');
    expect(byName.get('app.Color')?.kind).toBe('enum');
    expect(byName.get('app.freeFunction')?.kind).toBe('function');
  });

  it('treats .h as C++', async () => {
    const plugin = new CppLanguagePlugin();
    expect(plugin.supports('src/example.h')).toBe(true);
    const { result } = await parseCppFixture('exactness.h');
    expect(result.declarations.find((d) => d.qualifiedName === 'app.HeaderOnly')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/structured/cpp-parser.test.ts -v
```

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

C++ 用 5 ファイルを作成。`tree-sitter-cpp` grammar を使用する。`namespace_definition` → `namespace`、`function_definition` → `function`、`struct_specifier`/`class_specifier` → `struct`/`class`、`enum_specifier` → `enum`、クラス内の `function_definition`（デストラクタを含む）→ `method`/`constructor`。`preproc_include` → import（`#include <...>` と `"..."`）。

`src/plugins/languages/cpp.ts` は Rust と同じ構成で `languageId='cpp'`、`fileExtensions=['.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx']` とする。

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

- [ ] **Step 1: Write failing fixtures and test**

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

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/structured/python-pyi-parser.test.ts -v
```

Expected: PASS（Task 1 で `.pyi` ルーティングは追加済み、既存パーサが動作するため）

- [ ] **Step 3: Commit**

```bash
git add tests/unit/structured/python-pyi-parser.test.ts tests/fixtures/structured/python/exactness.pyi tests/fixtures/structured/python/partial.pyi
git commit -m "test(structured): add Python .pyi structured parser coverage"
```

---

## Task 8: プラグインレジストリ登録とルーティングテスト

**Files:**
- Modify: `src/server/factory.ts:604-606`
- Modify: `tests/unit/plugins/registry.test.ts`（既存ファイルまたは新規）
- Create: `tests/unit/plugins/languages/rust.test.ts`
- Create: `tests/unit/plugins/languages/java.test.ts`
- Create: `tests/unit/plugins/languages/csharp.test.ts`
- Create: `tests/unit/plugins/languages/c.test.ts`
- Create: `tests/unit/plugins/languages/cpp.test.ts`

**Interfaces:**
- Consumes: すべての新言語プラグイン
- Produces: `NexusServerFactory.setupPluginRegistry` で新プラグインが登録される

- [ ] **Step 1: Write failing tests**

`tests/unit/plugins/registry.test.ts` に追加（または新規作成）。既存の `PluginRegistry` を使って各言語が期待する拡張子にマッチすることを検証：

```typescript
import { describe, expect, it } from 'vitest';
import { CppLanguagePlugin } from '../../../src/plugins/languages/cpp.js';
import { CLanguagePlugin } from '../../../src/plugins/languages/c.js';
import { CSharpLanguagePlugin } from '../../../src/plugins/languages/csharp.js';
import { JavaLanguagePlugin } from '../../../src/plugins/languages/java.js';
import { RustLanguagePlugin } from '../../../src/plugins/languages/rust.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { PythonLanguagePlugin } from '../../../src/plugins/languages/python.js';
import { GoLanguagePlugin } from '../../../src/plugins/languages/go.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';

describe('PluginRegistry language routing', () => {
  it('routes all supported extensions', () => {
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    registry.registerLanguage(new PythonLanguagePlugin());
    registry.registerLanguage(new GoLanguagePlugin());
    registry.registerLanguage(new RustLanguagePlugin());
    registry.registerLanguage(new JavaLanguagePlugin());
    registry.registerLanguage(new CSharpLanguagePlugin());
    registry.registerLanguage(new CLanguagePlugin());
    registry.registerLanguage(new CppLanguagePlugin());

    expect(registry.getLanguagePlugin('src/a.rs')?.languageId).toBe('rust');
    expect(registry.getLanguagePlugin('src/a.java')?.languageId).toBe('java');
    expect(registry.getLanguagePlugin('src/a.cs')?.languageId).toBe('csharp');
    expect(registry.getLanguagePlugin('src/a.c')?.languageId).toBe('c');
    expect(registry.getLanguagePlugin('src/a.cpp')?.languageId).toBe('cpp');
    expect(registry.getLanguagePlugin('src/a.h')?.languageId).toBe('cpp');
    expect(registry.getLanguagePlugin('src/a.pyi')?.languageId).toBe('python');
    expect(registry.getLanguagePlugin('src/a.txt')?.languageId).toBeUndefined();
  });
});
```

各言語プラグインの `supports` テストも新規作成（例: `tests/unit/plugins/languages/rust.test.ts`）。

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/unit/plugins/registry.test.ts tests/unit/plugins/languages/rust.test.ts -v
```

Expected: FAIL（未登録・未定義）

- [ ] **Step 3: Modify factory registration**

`src/server/factory.ts` の `setupPluginRegistry` を編集：

```typescript
import { RustLanguagePlugin } from '../plugins/languages/rust.js';
import { JavaLanguagePlugin } from '../plugins/languages/java.js';
import { CSharpLanguagePlugin } from '../plugins/languages/csharp.js';
import { CLanguagePlugin } from '../plugins/languages/c.js';
import { CppLanguagePlugin } from '../plugins/languages/cpp.js';

// ... inside setupPluginRegistry:
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    registry.registerLanguage(new PythonLanguagePlugin());
    registry.registerLanguage(new GoLanguagePlugin());
    registry.registerLanguage(new RustLanguagePlugin());
    registry.registerLanguage(new JavaLanguagePlugin());
    registry.registerLanguage(new CSharpLanguagePlugin());
    registry.registerLanguage(new CLanguagePlugin());
    registry.registerLanguage(new CppLanguagePlugin());
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/plugins/registry.test.ts tests/unit/plugins/languages/rust.test.ts tests/unit/plugins/languages/java.test.ts tests/unit/plugins/languages/csharp.test.ts tests/unit/plugins/languages/c.test.ts tests/unit/plugins/languages/cpp.test.ts -v
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/factory.ts tests/unit/plugins/registry.test.ts tests/unit/plugins/languages/rust.test.ts tests/unit/plugins/languages/java.test.ts tests/unit/plugins/languages/csharp.test.ts tests/unit/plugins/languages/c.test.ts tests/unit/plugins/languages/cpp.test.ts
git commit -m "feat(plugins): register new language plugins and add routing tests"
```

---

## Task 9: Pipeline の import-only ファイル修正

**Files:**
- Modify: `src/indexer/pipeline.ts:465-467`
- Test: `tests/unit/indexer/pipeline-structured-imports.test.ts`

**Interfaces:**
- Consumes: `readStructuredFile` からの `StructuredParseResult`
- Produces: `status === 'ok' && declarations.length === 0 && imports.length > 0` の場合 `kind: 'work'` を返す

- [ ] **Step 1: Write failing test**

`tests/unit/indexer/pipeline-structured-imports.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { CppLanguagePlugin } from '../../../src/plugins/languages/cpp.js';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import { Chunker } from '../../../src/indexer/chunker.js';

describe('IndexPipeline structured import-only handling', () => {
  it('keeps an ok import-only file as structured work', async () => {
    const metadataStore = new InMemoryMetadataStore();
    const vectorStore = new InMemoryVectorStore({ dimensions: 3 });
    await metadataStore.initialize();
    await vectorStore.initialize();

    const pluginRegistry = new PluginRegistry();
    pluginRegistry.registerLanguage(new CppLanguagePlugin());
    pluginRegistry.registerEmbeddingProvider('test', new TestEmbeddingProvider({ dimensions: 3 }));
    pluginRegistry.setActiveEmbeddingProvider('test');

    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker: new Chunker(pluginRegistry),
      embeddingProvider: pluginRegistry.getEmbeddingProvider()!,
      pluginRegistry,
    });

    const content = '#include <stdio.h>\n';
    const bytes = Buffer.from(content, 'utf8');
    const result = await (pipeline as any).readStructuredFile(
      'header.h',
      'cpp',
      content,
      bytes,
    );

    expect(result?.kind).toBe('work');
    expect(result?.work?.imports.length).toBeGreaterThan(0);
    expect(result?.work?.declarations.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/indexer/pipeline-structured-imports.test.ts -v
```

Expected: FAIL（`retire` になる）

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
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/indexer/pipeline.ts tests/unit/indexer/pipeline-structured-imports.test.ts
git commit -m "fix(pipeline): keep ok import-only structured files as work"
```

---

## Task 10: パイプラインファイル取得テスト

**Files:**
- Modify: `src/indexer/pipeline.ts`（`detectLanguage` ルーティングを確認するだけ）
- Test: `tests/unit/indexer/pipeline-language-routing.test.ts`

**Interfaces:**
- Consumes: 登録済み `PluginRegistry`
- Produces: 各拡張子が正しい `languageId` を返す

- [ ] **Step 1: Write failing test**

`tests/unit/indexer/pipeline-language-routing.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { PythonLanguagePlugin } from '../../../src/plugins/languages/python.js';
import { GoLanguagePlugin } from '../../../src/plugins/languages/go.js';
import { RustLanguagePlugin } from '../../../src/plugins/languages/rust.js';
import { JavaLanguagePlugin } from '../../../src/plugins/languages/java.js';
import { CSharpLanguagePlugin } from '../../../src/plugins/languages/csharp.js';
import { CLanguagePlugin } from '../../../src/plugins/languages/c.js';
import { CppLanguagePlugin } from '../../../src/plugins/languages/cpp.js';

describe('IndexPipeline language detection', () => {
  const makePipeline = () => {
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    registry.registerLanguage(new PythonLanguagePlugin());
    registry.registerLanguage(new GoLanguagePlugin());
    registry.registerLanguage(new RustLanguagePlugin());
    registry.registerLanguage(new JavaLanguagePlugin());
    registry.registerLanguage(new CSharpLanguagePlugin());
    registry.registerLanguage(new CLanguagePlugin());
    registry.registerLanguage(new CppLanguagePlugin());
    return new IndexPipeline({
      metadataStore: {} as any,
      vectorStore: {} as any,
      chunker: {} as any,
      embeddingProvider: {} as any,
      pluginRegistry: registry,
    });
  };

  it('detects new language ids', () => {
    const pipeline = makePipeline();
    expect((pipeline as any).detectLanguage('src/main.rs')).toBe('rust');
    expect((pipeline as any).detectLanguage('src/Main.java')).toBe('java');
    expect((pipeline as any).detectLanguage('src/Main.cs')).toBe('csharp');
    expect((pipeline as any).detectLanguage('src/main.c')).toBe('c');
    expect((pipeline as any).detectLanguage('src/main.cpp')).toBe('cpp');
    expect((pipeline as any).detectLanguage('src/main.h')).toBe('cpp');
    expect((pipeline as any).detectLanguage('src/main.pyi')).toBe('python');
    expect((pipeline as any).detectLanguage('readme.txt')).toBe('text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/indexer/pipeline-language-routing.test.ts -v
```

Expected: FAIL（`.pyi` や新拡張子が `text` になる）

- [ ] **Step 3: Verify and adjust detectLanguage**

`src/indexer/pipeline.ts` の `detectLanguage` メソッドは既存で `plugin.languageId` を返す実装のはず。Task 1 と Task 8 で `.pyi` 拡張子追加と新プラグイン登録が済んでいれば、このテストは追加変更なしで通る。もし `detectLanguage` が `.endsWith('.py')` のようなハードコードを含む場合のみ修正する。

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/indexer/pipeline-language-routing.test.ts -v
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/unit/indexer/pipeline-language-routing.test.ts
git commit -m "test(pipeline): verify language detection for new extensions"
```

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
    for (const ext of ['.rs', '.java', '.cs', '.c', '.cpp', '.cxx', '.hpp', '.h', '.pyi']) {
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

- [ ] **Step 1: Run full test suite**

```bash
npm run test
```

Expected: PASS（全テスト）

- [ ] **Step 2: Run lint and type check**

```bash
npm run lint
npx tsc --noEmit
```

Expected: PASS / no errors

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: PASS

- [ ] **Step 4: Run license check**

```bash
npm run license:check
```

Expected: PASS

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "chore: address integration test findings"
```

---

## Self-Review

### 1. Spec coverage

| 設計書セクション | 実装タスク |
| --- | --- |
| §1 Parser framework: Tree-sitter | Task 1, 2, 3, 4, 5, 6（依存関係追加 + 各言語パーサ） |
| §2 Language plugin registration | Task 8（factory.ts 登録） |
| §3 Extension routing | Task 1（.pyi）、Task 2-6（各拡張子）、Task 10（detectLanguage 確認） |
| §4 SymbolKind extension | Task 1（src/types/index.ts） |
| §5 Language-specific declaration mapping | Task 2-6（各言語の declarations モジュール） |
| §6 Container and parent-child handling | Task 2-6（ownerName / parentSymbolId リンク） |
| §7 Stable symbol identity | Task 2-6（createSymbolId 使用、occurrence カウント） |
| §8 Import / include / use / using | Task 2-6（各言語 imports モジュール） |
| §9 Partial parse and fallback | Task 2-6（hasSyntaxProblem スキップ）、Task 9（import-only 修正） |
| §10 Incremental integration | Task 11（バックフィル手順ドキュメント） |
| テスト戦略 | Task 2-7, 9-12 |
| Acceptance Criteria | Task 1-12 |

### 2. Placeholder scan

計画内に以下の禁止パターンは出現しないことを確認済み：TBD, TODO, implement later, fill in details, "Add appropriate error handling", "Write tests for the above", "Similar to Task N" など。各 Task の Step 4 で fixture を実際に parse し、tree-sitter grammar node 名を確認すること。

### 3. Type consistency

- `SymbolKind` 追加値は Task 1 で一括定義。各言語パーサはそれらの値のみを返す。
- `qualifiedName` は全言語で `.` セパレタ（Rust も `module.Trait`, `Type.method`）。
- `LanguagePlugin.languageId` は設計書 §3 と一致: `rust`, `java`, `csharp`, `c`, `cpp`。
- `fileExtensions` は設計書 §3 と一致。
- `import` レコードの `completeness` は wildcard / unresolved を `partial`、C/C++ / C# / Java wildcard は `bindingName: undefined`。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-09-structured-index-language-extension.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints for review

**Which approach?**
