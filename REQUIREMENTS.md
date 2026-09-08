# Nexus 構造化インデックス対応言語・拡張子拡張

## 目的

Nexus の構造化インデックス対応範囲を拡大し、現在対応している TypeScript / JavaScript、Python、Go に加えて、Rust、Java、C#、C、C++ のコードでも、既存対応言語と同等レベルの構造化シンボル取得体験を提供する。

あわせて Python type stub (`.pyi`) を構造化インデックス対象に追加する。

## 背景

現在の Nexus は、AST-aware indexing と structured symbol catalog を利用し、TypeScript / JavaScript、Python、Go に対して stable `symbolId`、exact symbol source、bounded context、file outline を提供している。

現行の言語プラグイン構成も TypeScript、Python、Go を中心としており、`src/plugins/languages/` に各言語の structured parser 関連実装が配置されている。

TypeScript / JavaScript は現在すでに以下の拡張子を認識しているため、今回 `.mjs`, `.cjs`, `.mts`, `.cts` を新規対応する必要はない。

* `.ts`
* `.tsx`
* `.js`
* `.jsx`
* `.mjs`
* `.cjs`
* `.mts`
* `.cts`

Python は現状 `.py` のみを対象としているため、`.pyi` が今回の追加対象となる。

## ユーザー価値

Rust、Java、C#、C/C++ を利用するリポジトリでも、AIエージェントがファイル全体を読み込むことなく、論理シンボル単位で正確なコードを取得できるようにする。

特に以下の既存 Nexus ワークフローを対象言語でも利用可能にする。

* 検索結果から `symbolId` を取得する
* `get_symbol_source` で完全な論理宣言を取得する
* `get_symbol_context` でシンボルと関連コンテキストを取得する
* file outline でファイル内構造を把握する
* 構造化解析が不完全でも通常の検索・context取得を継続する

既存 Nexus でも、structured retrieval が unsupported / degraded の場合には行ベースの `get_context` を利用するフローが定義されている。

## 対象ユーザー

主な対象は以下。

* Nexus を利用してコードベースを探索するAIエージェント
* Rust / Java / C# / C / C++ を含むコードベースで Nexus を利用する開発者
* `.pyi` を多く含むPythonコードベースの利用者

## 実現したい振る舞い

新規対応言語について、単に「ファイルとしてインデックスできる」だけではなく、現在の structured retrieval と同等のユーザー体験を提供する。

最低限、対象となる主要宣言について以下を成立させる。

* ファイルoutlineに現れる
* 論理的な親子関係を保持できる
* 適切な qualified name を持つ
* stable `symbolId` を持つ
* exact source retrieval ができる
* bounded symbol context retrieval ができる
* import / include / use 等の関連情報を扱える

現行 structured contract には `qualifiedName`, `symbolId`, `parentSymbolId`, source range、source hash、import binding 等の情報が存在するため、新言語についてもこれらの既存契約との整合を保つ。

## 対応言語・拡張子

### 既存対応

#### TypeScript / JavaScript

既存対応を維持する。

* `.ts`
* `.tsx`
* `.js`
* `.jsx`
* `.mjs`
* `.cjs`
* `.mts`
* `.cts`

今回の新規実装対象ではない。

#### Python

* `.py`
* `.pyi` ← 新規追加

#### Go

* `.go`

既存対応を維持する。

### 新規対応

#### Rust

* `.rs`

#### Java

* `.java`

#### C#

* `.cs`

#### C

* `.c`

#### C++

* `.h`
* `.cc`
* `.cpp`
* `.cxx`
* `.hh`
* `.hpp`
* `.hxx`

`.h` は曖昧性を自動判定せず、**C++ として扱う**。

## 主要ユースケース

### 1. Rust のコード探索

`.rs` ファイルから主要な型・関数・trait・impl等を構造化シンボルとして認識し、検索結果から正確な宣言へ移動できる。

### 2. Java のクラス探索

`.java` ファイルから class / interface / enum / record と、その配下のmethod等をoutlineとして確認し、任意のシンボルの完全なsourceを取得できる。

### 3. C# の型・property探索

`.cs` ファイルから class / interface / struct / enum / record、method、constructor、property等を構造化して取得できる。

### 4. C/C++ のコード探索

`.c` / `.cpp` 等から function、class、struct、namespace等を取得し、`#include` も関連情報として認識できる。

`.h` は C++ として解析される。

### 5. Python stub の探索

`.pyi` に存在する class、function、method等を `.py` と同様に構造化取得できる。

### 6. 編集途中のファイル

一部に構文エラーが存在しても、パーサーが安全に認識できる宣言についてはstructured dataを提供する。

ファイル全体を正確に解析できないことだけを理由に、利用可能なシンボルまで破棄しない。

## 機能要件

### FR-1: Rust対応

Rustについて、少なくとも以下の日常的な主要構文を構造化インデックス対象とする。

* `struct`
* `enum`
* `trait`
* `impl`
* `impl` 内method
* `fn`
* `mod`
* `use`

高度な特殊構文を完全に意味解析することは今回の必須条件ではない。

### FR-2: Java対応

Javaについて、少なくとも以下を対象とする。

* class
* interface
* enum
* record
* method
* constructor
* field
* import

### FR-3: C#対応

C#について、少なくとも以下を対象とする。

* class
* interface
* struct
* enum
* record
* method
* constructor
* property
* namespace
* using

### FR-4: C対応

Cについて、少なくとも以下を対象とする。

* function
* struct
* enum
* include

### FR-5: C++対応

C++について、少なくとも以下を対象とする。

* function
* struct
* class
* enum
* namespace
* method
* constructor
* `#include`

### FR-6: Python `.pyi` 対応

既存Python structured indexing の対象拡張子へ `.pyi` を追加し、通常のPython宣言と同様に主要シンボルを取得可能にする。

### FR-7: シンボルの論理構造

新規言語でも、取得可能な宣言について以下を保持する。

* symbol name
* symbol kind
* qualified name
* source position / range
* 親子関係
* stable `symbolId`
* exact source取得に必要な情報

現在の `StructuredDeclaration` がこれらを保持する契約になっている。

### FR-8: import相当情報

言語ごとの以下の構文を、structured context で利用できる関連情報として扱う。

* Rust: `use`
* Java: `import`
* C#: `using`
* C/C++: `#include`

具体的な内部表現や抽出方式は設計フェーズで決定する。

### FR-9: 部分解析

構文エラー等が存在しても、正確に認識できるシンボルは可能な限り提供する。

不正確なシンボルを推測して「exact」として提供してはならない。

現行契約には `fileCompleteness: complete | partial` と `degraded` / partial retrieval が存在するため、この意味論を維持する。

### FR-10: 解析不能時のフォールバック

structured parser が有効な結果を生成できない場合でも、そのファイルを Nexus 全体のインデックス対象外にはしない。

以下は継続利用可能であること。

* semantic search
* grep search
* 通常のchunk indexing
* 行ベースのcontext取得

structured retrieval のみ degraded / unsupported / failed 等の適切な状態を返す。

### FR-11: 通常更新フローへの統合

アップグレード後、既存ワークスペース内にすでに存在する新規対応言語のファイルについて、専用のmigration操作を要求しない。

通常のindex scan / incremental updateフローを通じて、structured indexing対象として認識されること。

強制的な全件再構築を新言語対応の必須条件にはしない。

Nexus は現状 file watching、diff detection、recovery queue によるincremental indexingを提供している。

## C/C++ 固有要件

C/C++ のstructured indexingは、**ソースファイル単体で利用可能であること**を要件とする。

以下を必須入力としない。

* `compile_commands.json`
* build system情報
* include path設定
* compiler defines
* 完全なpreprocessor evaluation

そのため、以下の完全解決は今回保証しない。

* マクロ展開後の完全な意味
* 条件付きコンパイル結果の完全な再現
* build configurationによって変化する型・宣言の意味解析

これらがなくても、ソース上で直接認識できる主要宣言や `#include` を構造化できることを優先する。

## 非機能要件

### NFR-1: 既存言語との互換性

TypeScript / JavaScript、Python、Go の現在のstructured retrieval体験を維持する。

少なくとも以下の既存ユースケースを壊さない。

* file outline
* `get_symbol_source`
* `get_symbol_context`
* 主要シンボル検出
* stable `symbolId`

同一の論理宣言について、今回の変更のみを理由として既存 `symbolId` を変更しないことを原則とする。

現行仕様でも `symbolId` はbody textやline numberではなく論理的identityから生成され、宣言の単純移動だけではIDを変更しない契約になっている。

### NFR-2: Fail-closed exactness

解析結果に確信が持てない場合、不正確なsourceをexact structured resultとして返してはならない。

partial / degraded / unsupported 等を明示し、推測によるexact retrievalを行わない。

これは現行のstructured retrieval契約を維持する。

### NFR-3: Incremental indexingとの整合

新規対応言語も既存のwatcher / incremental indexing / reconciliationフローに従うこと。

新言語だけ別途手動更新を必要とするUXにしない。

### NFR-4: Local-first

言語の構造解析そのもののために外部サービスへの接続を必須としない。

Nexusのlocal-firstな実行特性を維持する。

### NFR-5: 既存公開契約との整合

現在のstructured catalogおよびMCP structured retrievalの公開的な意味論を不用意に破壊しない。

内部アーキテクチャや利用パーサーの選択はこの要件では固定しない。

## 制約

* 対象リポジトリは `yohi/nexus` の現行 `master`。
* Nexus の現行実行要件である Node.js 24+ と整合すること。
* structured parserの実装方式・parser library・内部ファイル分割はこの要件では決定しない。
* 既存の `StructuredLanguageParser` / structured catalogとの整合を考慮すること。
* 既存 `SymbolKind` は現在 `namespace`, `class`, `interface`, `enum`, `function`, `method`, `property`, `constructor`, `import` 等の共通kindを持つが、Rust `trait` や `struct` などの言語固有概念を直接表すkindは存在しない。
* そのため、新しい言語固有構文を既存kindへどう表現するか、あるいは公開契約を拡張するかは `brainstorming` で比較検討する。

## 既存システムとの関係

現在、structured language implementationは `src/plugins/languages/` にTypeScript、Python、Goごとの実装として存在する。

`LanguagePlugin` は `languageId`, `fileExtensions`, `supports()`, parser生成、およびoptionalなstructured parser生成という契約を持つ。

Structured data側では以下が既存契約として存在する。

* `StructuredLanguageParser`
* `StructuredDeclaration`
* `StructuredImport`
* `StructuredGeneration`
* structured retrieval status
* complete / partial coverage

新言語対応はこれら既存の利用フローを拡張するものとして扱い、structured indexingとは別の新しいユーザー向け取得方式を導入することは目的としない。

## 対象範囲

今回の対象。

* Python `.pyi`
* Rust `.rs`
* Java `.java`
* C# `.cs`
* C `.c`
* C++ `.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx`
* 各言語の日常的な主要宣言
* import / use / using / include相当
* outline
* parent-child structure
* qualified name
* stable symbol identity
* exact source retrieval
* bounded symbol context
* partial parse
* parsing failure fallback
* incremental indexing integration
* 既存言語の回帰防止

## 非対象範囲

今回、以下の完全対応は要求しない。

### Rust

* 全macro expansion
* proc macroの展開結果
* compiler-level semantic resolution

### Java

* compiler相当の型解決
* annotation processor展開結果

### C#

* compiler相当の完全なsemantic resolution
* source generatorの生成結果

### C/C++

* template特殊化の完全意味解析
* operator overloadの詳細semantic resolution
* macro expansionの完全再現
* preprocessor configurationの完全解決
* compile commandsを前提とした型解決
* include graphのコンパイラ相当の解決

### 全言語共通

* 新しい検索APIの設計
* 新しいMCP toolの追加
* structured indexingアーキテクチャの全面刷新
* parser libraryの要件段階での固定
* 内部データモデルの詳細設計
* Ruby / PHP / Kotlin / Swift 等の追加言語対応

## エッジケース

以下を少なくとも考慮する。

### 構文エラー

ファイルの一部が壊れている場合でも、安全に認識できる宣言は提供する。

解析不能部分を推測してexact resultにしてはならない。

### 完全な解析不能

structured resultを生成できない場合は、通常インデックスへフォールバックする。

ファイル自体を検索不能にはしない。

### `.h`

`.h` は内容や周辺ファイルからC/C++を自動判定せず、C++として扱う。

### 同名・overload

同一scope内に同名method/function等が複数存在する言語では、stable `symbolId` が論理宣言を区別できること。

具体的なidentity生成方式は設計フェーズで既存契約と照合する。

### nested declarations

class / namespace / impl等の内部宣言について、親子関係とqualified nameを失わないこと。

### importの部分解析

一部のimport/include/useが解析できなくても、取得できる主要宣言まで無効にしない。

### 編集途中のファイル

watcherが一時的なsyntax error状態を拾った場合でも、Nexus全体のindex pipelineを停止させない。

## 受け入れ条件

### AC-1: 拡張子認識

以下の拡張子が期待する言語としてstructured indexingへルーティングされる。

* `.pyi` → Python
* `.rs` → Rust
* `.java` → Java
* `.cs` → C#
* `.c` → C
* `.h` → C++
* `.cc` → C++
* `.cpp` → C++
* `.cxx` → C++
* `.hh` → C++
* `.hpp` → C++
* `.hxx` → C++

### AC-2: Rust fixture

代表fixtureで以下が認識される。

* struct
* enum
* trait
* impl
* impl method
* fn
* mod
* use

主要シンボルについてoutline、qualified name、親子関係、stable `symbolId`、exact source取得を検証する。

### AC-3: Java fixture

代表fixtureで以下を検証する。

* class
* interface
* enum
* record
* method
* constructor
* field
* import

### AC-4: C# fixture

代表fixtureで以下を検証する。

* class
* interface
* struct
* enum
* record
* method
* constructor
* property
* namespace
* using

### AC-5: C/C++ fixture

代表fixtureで以下を検証する。

* function
* struct
* class（C++）
* enum
* namespace（C++）
* method（C++）
* constructor（C++）
* `#include`

`.h` fixtureがC++として処理されることも検証する。

### AC-6: `.pyi` fixture

`.pyi` ファイルが `.py` と同様にPython structured parser対象となり、代表的なclass / function / method等を取得できる。

### AC-7: exact retrieval

各新規言語の代表シンボルについて、検索・outline等から得られた `symbolId` を使い、`get_symbol_source` が完全な論理宣言を返せる。

### AC-8: context retrieval

各新規言語の代表シンボルについて `get_symbol_context` が利用可能で、関連するimport相当情報を扱える。

### AC-9: partial parse

意図的にsyntax errorを含むfixtureで、エラー以外の安全に解析可能なシンボルが保持される。

結果が完全でない場合、その状態がexact coverageとして偽装されない。

### AC-10: fallback

解析不能なfixtureでも通常のインデックス処理が成功し、semantic / grep / line-based context等の非structured機能が利用可能な状態を維持する。

### AC-11: incremental update

既存ワークスペースの対象ファイルが、専用migration操作なしで通常のscan / updateフローからstructured対象になる。

変更後のファイルも既存watcherフローから更新される。

### AC-12: stable identity

bodyの変更や、論理identityを変えない範囲での位置変更によって、不要に `symbolId` が変化しないことを代表ケースで検証する。

### AC-13: 既存言語の回帰テスト

TypeScript / JavaScript、Python、Go の既存structured indexingテストが維持される。

少なくとも以下に重大な回帰がないこと。

* symbol detection
* outline
* parent relationship
* qualified name
* `symbolId`
* exact source
* symbol context
* import handling
* degraded / fallback behavior

### AC-14: プロジェクト全体の品質チェック

変更後、リポジトリで要求される関連test / typecheck / lint / buildが成功すること。

README上の現行development workflowは `npm run build`, `npm run lint`, `npx tsc --noEmit`, `npx vitest run` を含む。

## 既知の未解決事項

以下は要件不足ではなく、`superpowers:brainstorming` で設計案を比較すべき事項。

1. **各新規言語のparser方式**

   * Tree-sitter等を利用するか
   * 別のparser APIを利用するか
   * 言語ごとに異なる方式を許容するか

2. **既存 `SymbolKind` と言語固有構文の対応**

   * Rust `struct`, `trait`, `impl`
   * Java/C# `record`
   * C/C++ `struct`

   これらを既存kindへマッピングするか、kind契約自体を拡張するか。

3. **`impl` 等のcontainer表現**

   * 独立したlogical symbolとするか
   * child methodのparent情報としてのみ利用するか

4. **C/C++ include等の `StructuredImport` への表現方法**

5. **各言語におけるstable `symbolId` のidentity discriminator**

   * overload
   * constructor
   * namespace
   * nested type
     等を既存identity contractとどう整合させるか。

これらは実装方式に関する判断であり、本要件では固定しない。

## 参照すべきリポジトリ・ファイル

Repository:

* `https://github.com/yohi/nexus`

特に確認すべき現行ファイル:

* `README.md`

  * structured retrievalの現在のユーザー体験
  * indexing / fallback workflow
* `SPEC.md`

  * structured symbol retrievalのcanonical behavioral contract
  * stable `symbolId`
  * exactness / fail-closed
  * incremental indexing
* `src/structured/contracts.ts`

  * structured parser/result/status contract
* `src/types/index.ts`

  * `SymbolKind`
  * `LanguagePlugin`
* `src/plugins/registry.ts`

  * language plugin registration
* `src/plugins/languages/interface.ts`
* `src/plugins/languages/typescript.ts`
* `src/plugins/languages/typescript-structured.ts`
* `src/plugins/languages/python.ts`
* `src/plugins/languages/python-structured.ts`
* `src/plugins/languages/go.ts`
* `src/plugins/languages/go-structured.ts`
* `tests/`

  * structured indexing / retrieval / language pluginの既存テストとfixture

現行 `src/plugins/languages/` にはTypeScript・Python・Go向けのstructured implementationが分割配置されているため、新言語設計時の既存パターン比較対象とする。

## brainstorming への依頼

上記要件を前提として、新規言語対応の実装アプローチを複数案比較してください。

特に以下を比較対象にしてください。

* parser / grammar選定方針
* 新規言語を既存structured contractへ統合する方法
* `SymbolKind` の扱い
* stable `symbolId` の既存契約との整合
* partial parse / degraded behavior
* import/include/use/usingの扱い
* language plugin追加時の共通化範囲
* dependency / distributionへの影響
* テスト戦略

既存TypeScript / Python / Goの公開挙動を維持することを前提とし、最初から単一案へ固定せず、現行コードとの整合・保守性・言語間一貫性を比較したうえで推奨案を提示してください。

