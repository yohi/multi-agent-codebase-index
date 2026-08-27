# Nexus Structured Symbol Retrieval 設計

- Status: Approved
- Date: 2026-08-27
- Requirements: [`REQUIREMENTS-20260827.md`](../../../REQUIREMENTS-20260827.md)
- Reference implementation: [`jgravelle/jcodemunch-mcp`](https://github.com/jgravelle/jcodemunch-mcp/tree/83dd803897761a4169c23168f0381712b9d90947)

## 1. Summary

Nexusへlogical symbol単位のstructured retrievalを追加する。

既存のsemantic、hybrid、grep discoveryは維持し、検索用`CodeChunk`と
retrieval用logical symbolを別の永続モデルとして扱う。検索chunkが分割されても、
検索結果からversion付きstable symbol IDを取得し、完全なsymbol sourceへ直接進める。

新機能の中核は次のとおりである。

1. SQLiteにlogical symbol catalogを追加する。
2. LanceDBの検索chunkへ任意のstable symbol IDを付与する。
3. file outline、exact source、bounded context用のMCP toolを追加する。
4. current working treeのcontent hashを検証し、stale時はsourceを返さない。
5. parserがexactnessを保証できない場合はdegradedまたはunsupportedを返す。
6. fixed tokenizerによりbounded contextのbudgetを再現可能に計測する。
7. 既存6 MCP toolと従来のfile/line retrievalを維持する。

## 2. Goals

### 2.1 Primary goal

AI agentがsemanticまたはhybrid searchで発見したlogical symbolを、追加の名前検索や
file全体の取得なしに、完全かつ検証済みのsourceとして取得できるようにする。

### 2.2 Secondary goals

- 既知fileからfull sourceなしでsymbol outlineを取得する。
- symbolと確実に関連するimportsだけをbounded contextとして取得する。
- token budgetよりsymbol完全性を優先する。
- freshness、coverage、parser confidence、budget overflowをmachine-readableにする。
- structured retrievalをembedding providerのavailabilityから分離する。

## 3. Non-goals

次は本設計へ含めない。

- repository-wide outlineまたはfile tree
- call graph、caller graph、blast radius、impact analysis
- transitive dependency resolution
- arbitrary grep hitからsymbolへの自動mapping
- symbol renameまたはfile move後のidentity追跡
- new programming language support
- AI-generated summary
- CLI版structured retrieval
- automatic index migration
- fixed token削減率KPI
- jCodeMunchとの全面的なAPI互換

CodeGraphが存在するrepositoryでは、構造探索、call path、dependency traversal、
blast radiusは引き続きCodeGraphの責務とする。

## 4. Confirmed design decisions

| Topic | Decision |
| --- | --- |
| MCP surface | 既存toolの拡張ではなく専用toolを追加する |
| Stale source | 本文を返さないfail-closed |
| Token accounting | 固定tokenizerとversionをresponseへ明示する |
| Public identity | Version付きの決定論的opaque ID |
| Import fallback | 確実な関連importだけを返し、不確実性を明示する |
| Symbol storage | SQLite Symbol Catalog |
| Search storage | LanceDBは検索chunkとembeddingに限定する |
| Exact source | Freshなworking-tree bytesをhash検証後にsliceする |
| Python/Go parser | Tree-sitter based structured parserへ置換する |
| TypeScript parser | TypeScript Compiler APIを維持・拡張する |
| Upgrade | 明示的full reindexを要求し、自動migrationしない |

## 5. Architecture

### 5.1 Component boundaries

```text
                           ┌──────────────────────────────┐
                           │          MCP tools           │
                           │ outline / source / context   │
                           └──────────────┬───────────────┘
                                          │
                           ┌──────────────▼───────────────┐
                           │  Symbol Retrieval Service    │
                           │ scope / freshness / budget   │
                           └───────┬──────────────┬───────┘
                                   │              │
                         ┌─────────▼──────┐ ┌─────▼──────────┐
                         │ SQLite Symbol │ │ Local file read │
                         │ Catalog       │ │ + hash verify   │
                         └────────────────┘ └────────────────┘

┌──────────────┐  ┌──────────────────┐  ┌────────────────────┐
│ File loader  │─▶│ Language parser  │─▶│ Structured artifact│
└──────────────┘  └──────────────────┘  └──────┬─────────┬───┘
                                                │         │
                                     ┌──────────▼─┐ ┌────▼────────┐
                                     │ Symbol     │ │ Search      │
                                     │ Catalog    │ │ Chunker     │
                                     └────────────┘ └────┬────────┘
                                                         │
                                                  ┌──────▼──────┐
                                                  │ LanceDB     │
                                                  │ CodeChunk   │
                                                  └─────────────┘
```

### 5.2 Parser output and search chunks

Language parserはfileごとに1つのstructured artifactを生成する。artifactは、
file content hash、parse status、coverage、logical declarations、imports、diagnosticsを
保持する。

`Chunker`は同じartifactから従来の検索chunkを生成する。1 logical symbolが
`maxChunkChars`により複数chunkへ分割された場合、全chunkへ同じ`symbolId`を付与する。

Parser unavailable、parser failure、declaration boundary不明の場合、検索は従来の
fixed-line fallbackを使用できる。ただしfallback chunkへ`symbolId`は付与しない。

### 5.3 Storage responsibilities

#### SQLite Metadata Store

SQLiteは次の正本を保持する。

- structured file generationとparse status
- stable symbol identityとoutline metadata
- symbolのline/byte rangeとsource hash
- parent-child relationship
- import declarationとbinding
- 確実に解決したsymbol-import relationship
- retired symbol tombstone
- structured schema version

#### LanceDB Vector Store

LanceDBは次だけを保持する。

- existing `CodeChunk`
- embedding vector
- structured declaration由来chunkの任意`symbolId`

LanceDBをoutline、hierarchy、freshness、complete sourceの正本にはしない。

#### Working tree

Source本文はSQLiteへ複製しない。Exact retrieval時にcurrent working treeのfileを1回だけ
bytesとして読み、indexed file hashとの一致確認後、catalogのbyte rangeでsliceする。

## 6. Structured data model

### 6.1 File generation

File catalog更新はgeneration単位で行う。Generation IDは次のcanonical inputのhashとする。

- structured schema version
- parser IDとparser version
- file content hash

同じfile contentでもparser contractが変われば別generationになる。

Conceptual tablesは次のとおりである。

#### `structured_files`

| Column | Purpose |
| --- | --- |
| `file_path` | Project-relative canonical path、primary key |
| `language` | Language ID |
| `active_generation` | Retrievalに利用できるgeneration |
| `pending_generation` | Cross-store更新中のgeneration |
| `parse_status` | `exact`, `degraded`, `unsupported` |
| `coverage` | `complete`, `partial`, `none` |
| `content_hash` | Active catalog作成元fileのhash |
| `parser_id` | Parser implementation ID |
| `parser_version` | Parser contract version |

#### `symbol_generations`

| Column | Purpose |
| --- | --- |
| `file_path` | Owner file |
| `generation` | Generation ID |
| `state` | `pending`, `active`, `retired` |
| `content_hash` | Parsed bytesのhash |
| `created_at` | Generation作成日時 |

#### `symbols`

Primary keyは`file_path`, `generation`, `symbol_id`の組み合わせとする。

| Column | Purpose |
| --- | --- |
| `symbol_id` | Public stable ID |
| `name` | Simple name |
| `qualified_name` | Language-aware qualified name |
| `kind` | Existing `SymbolKind` |
| `signature` | Human-readable signature |
| `signature_discriminator` | Identity用normalized signature |
| `parent_symbol_id` | Parent relationship |
| `start_line`, `end_line` | 1-based inclusive line range |
| `start_byte`, `end_byte` | UTF-8、end-exclusive byte range |
| `source_hash` | Complete symbol bytesのhash |
| `retrievability` | `exact`, `degraded` |
| `import_completeness` | `complete`, `partial`, `unavailable` |

#### `imports`

Import declarationの完全source range、binding、alias、module specifierをgeneration単位で
保持する。Import source本文は保持せず、byte rangeとhashを保持する。

#### `symbol_imports`

Symbolと確実に参照されたimport bindingの関係を保持する。推測relationは保存しない。

#### `symbol_tombstones`

Retired symbol ID、元file path、retired reason、retired timestampを保持する。
同じIDが再登場した場合はtombstoneを削除する。Tombstone履歴がない任意IDは
`not_found`として扱う。

### 6.2 Stable identity

Public ID formatは次のとおりである。

```text
symbol_v1_<base64url-sha256>
```

SHA-256 inputはcanonical JSON arrayとする。

```json
[
  1,
  "src/auth.ts",
  "AuthService.authenticate",
  "method",
  "authenticate(string):Promise<User>",
  0
]
```

各要素は次を表す。

1. Identity schema version
2. POSIX separatorへ正規化したproject-relative file path
3. Qualified name
4. Symbol kind
5. Language-specific normalized signature discriminator
6. 同一parent内でcanonical identityが完全重複する場合のoccurrence

Body hash、doc comment、line、byte offsetはidentityへ含めない。そのためbody変更、line移動、
周辺コード変更、通常reindexではIDを維持する。

Rename、file move、signature変更はlogical identity変更として新IDになる。完全に同一の
qualified name、kind、signatureが重複する場合、source順occurrenceを使用する。
同一重複集合の追加・削除・並べ替えはdisambiguation setの変更であり、該当IDの変更を許容する。

### 6.3 Qualified names

- TypeScript: `Namespace.Class.method`
- Python: `Class.method`、top-level declarationはsimple name
- Go: `Receiver.Method`、top-level declarationはsimple name
- Anonymous/default export: language adapterが決定論的なreserved nameを与える

## 7. Parser design

### 7.1 Shared contract

```ts
interface StructuredParseResult {
  status: 'exact' | 'degraded' | 'unsupported';
  coverage: 'complete' | 'partial' | 'none';
  diagnostics: ParseDiagnostic[];
  declarations: StructuredDeclaration[];
  imports: StructuredImport[];
}
```

`StructuredDeclaration`は次を含む。

- `name`, `qualifiedName`, `kind`
- Display用`signature`
- Identity用`signatureDiscriminator`
- Parser-local parent key
- 1-based inclusive line range
- UTF-8、end-exclusive byte range
- Complete source hash
- `retrievability`
- 確実に参照したimport binding IDs

Parser artifactはindexing中だけsource本文を保持できる。本文はSQLiteへ保存しない。

### 7.2 TypeScript family

対象extensionは既存どおり`.ts`, `.tsx`, `.js`, `.jsx`とする。Parser backendは
TypeScript Compiler APIを維持する。

対象declarationは、ASTが安全に境界を提供する次のkindとする。

- namespace/module
- class
- interface
- type alias
- enum
- function
- method、getter、setter
- constructor
- property
- variable、constant

Declaration startはAST上でnodeへattachされたJSDoc、decorator、modifierの最初のbyteとする。
単に近接するだけのunattached commentは含めない。Endはdeclaration nodeのend byteとする。

Overload signatureとimplementationは別logical declarationとしてcatalog化する。
TypeScriptのUTF-16 source positionはfile単位のoffset mapでUTF-8 byte offsetへ変換する。

### 7.3 Python

Structured parserはNode版`tree-sitter`と公式`tree-sitter-python` grammarを使う。

対象は次とする。

- top-level class
- top-level function、async function
- class method

現行parserのscopeを不用意にnested functionまで広げない。同じindentでdeclarationへ付く
decorator列をsource startへ含める。Docstringはbody内に含まれるためcomplete sourceへ
自然に含まれる。Preceding `#` commentはPython doc contractではないため自動付加しない。

### 7.4 Go

Structured parserはNode版`tree-sitter`と公式`tree-sitter-go` grammarを使う。

対象は次とする。

- type declaration
- function
- receiver method
- interface member等、grammarが安全な境界を返すdeclaration

Declarationへ直接attachされた連続doc commentをsource startへ含める。Receiver methodの
parentは同一file内でreceiver typeを解決できる場合のみ設定する。別fileの場合はparentを
nullとし、qualified nameにはreceiverを含める。

### 7.5 Exactness and partial parse

ERROR/MISSING nodeを含まず、ancestor chain、boundary、signatureを確定できるdeclarationだけを
`retrievability: exact`としてcatalog化する。

File内の一部にsyntax errorがある場合、file coverageは`partial`、outline statusは
`degraded`となる。Outlineはexact subsetだけを返せる。Exact subsetのsymbol IDは、
freshnessとsource hash検証に成功すれば個別のexact retrievalを`ok`にできる。

不確実なdeclarationにはpublic IDを付与せず、fixed-line searchだけに残す。

### 7.6 Related import analysis

Related import判定は同一file内の保守的なlexical binding解析に限定する。

1. Import aliasとbindingを抽出する。
2. Symbol subtree内のidentifier参照と照合する。
3. Parameter、local variable等にshadowされたbindingを除外する。
4. Namespace importと明示aliasは確実に解決できる場合だけ採用する。
5. Dynamic access、star/dot import、Goの暗黙package名等を推測しない。

曖昧さが1件でもあれば`importsCompleteness: partial`とする。Binding解析自体を提供できない
場合は`unavailable`とする。

## 8. Indexing and consistency

### 8.1 File update flow

1. Existing watcher/reindex scopeでfileを選択する。
2. File bytesとcontent hashを取得する。
3. Language parserがstructured artifactを生成する。
4. Identity generatorがexact declarationへstable IDを付与する。
5. SQLiteへnew generationを`pending`としてstageする。
6. Chunkerがsearch chunksと任意`symbolId`を生成する。
7. LanceDBの対象file chunksを置換する。
8. SQLite transactionでnew generationを`active`へ切り替える。
9. Old generationをretireし、消えたIDをtombstoneへ記録する。
10. Retired generationのcatalog rowsをGCする。

### 8.2 Cross-store failure

SQLiteとLanceDBを跨ぐdistributed transactionは導入しない。Pending/active generationにより
中間状態を明示する。

- ParserまたはLanceDB更新失敗: active generationを維持し、new generationをactivateしない
- LanceDB成功後のactivation失敗: pendingを残し、対象fileをDLQ/incomplete状態にする
- Searchがpending IDを返した場合: retrievalは`index_incomplete`を返す
- Active IDとpending IDが同一でもcurrent fileがpending contentの場合:
  pending generationを検出し、old sourceを返さず`index_incomplete`を返す

Failureは既存DLQ、`lastError`、reindex completion contractへ統合する。

### 8.3 Delete and move

Delete処理はLanceDB chunksとactive catalogを削除し、retired IDsをtombstoneへ記録する。

File moveはidentity維持対象外である。Structured fileはdelete+addとして再解析する。
Embeddingはexisting content-hash cacheを再利用し、同一contentでのprovider再計算を避ける。

## 9. Retrieval service

`SymbolRetrievalService`相当のapplication boundaryをtool handlerとstorageの間に置く。

Responsibilitiesは次に限定する。

1. Path sanitizationとexisting index scope検証
2. Active generationまたはtombstoneによるstrict identity resolution
3. Current file bytesのsingle read
4. Indexed file hashとのfreshness比較
5. Byte range sliceとsymbol hash再検証
6. Import selectionとtoken budget packing
7. Machine-readable statusとtrust metadata構築

Name、line、類似signatureによるfallbackは行わない。

### 9.1 Freshness algorithm

Exact sourceとbounded contextでは次の順序を固定する。

1. Active symbol recordをresolveする。
2. Current fileを1つの`Uint8Array`として読む。
3. Buffer全体のhashをactive generation content hashと比較する。
4. 不一致ならsourceなし`stale`を返す。
5. 同じbufferから`startByte:endByte`をsliceする。
6. Slice hashをsymbol source hashと比較する。
7. 一致時だけ`ok`とcomplete sourceを返す。

同じbufferを検証とsliceに使うため、hash確認後の再readによるTOCTOUを避ける。

Current fileが消失しているがcatalogがまだactiveの場合は`stale`を返す。Watcherがdeleteを
処理した後はIDがtombstone化され、`stale_identity`を返す。

## 10. MCP tools

既存6 toolは維持する。次の3 toolを追加する。

### 10.1 `get_file_outline`

Input:

```ts
{
  filePath: string;
}
```

Outputはfile sourceを含まない。Freshなcomplete fileでは`status: ok`、partial parseでは
`status: degraded`とexact subset、`coverage: partial`を返す。Stale fileでは古い位置情報を
返さない。

Symbol entryは次を含む。

- `symbolId`
- `name`
- `qualifiedName`
- `kind`
- `signature`
- `position`
- `parentSymbolId`

Entriesはpreorder DFSで返し、parentの直後にchildrenを配置する。

### 10.2 `get_symbol_source`

Input:

```ts
{
  symbolId: string;
}
```

成功時だけcomplete `source`を返す。Non-`ok` responseには`source` key自体を含めない。

### 10.3 `get_symbol_context`

Input:

```ts
{
  symbolId: string;
  tokenBudget: number;
}
```

`tokenBudget`はpositive integerとし、surrounding contextの無制限要求を避けるため
100,000以下に制限する。Symbol source自体がbudgetを超える場合でもcomplete sourceを返す。

Packing orderは次のとおりである。

1. Complete symbol source
2. Source orderに並べた、確実に関連するimport declarations

Import declarationは途中切断しない。次のimportがbudgetへ収まらない場合は省略する。
全importへのfallbackは行わない。

Token usageは、採用importsをsource orderで連結し、blank lineを1つ挟んでsymbol sourceを
置いたcanonical context textに対して計測する。MetadataとJSON serialization overheadは
budget対象外とする。

## 11. Token accounting

Tokenizerは`js-tiktoken/lite`とlocal `cl100k_base` ranksを使用する。

- Runtime network fetchなし
- WASM assetなし
- Encodingは`cl100k_base`
- Package versionは`package-lock.json`で固定
- Special tokenは通常textとして扱う

Responseは次を含む。

```ts
{
  tokenizer: 'cl100k_base';
  tokenizerVersion: 'js-tiktoken@<locked-version>';
  requestedTokens: number;
  actualTokens: number;
  exceeded: boolean;
  omittedImports: number;
}
```

`actualTokens`は下流LLMの実token使用量ではなく、この固定Nexus accounting contractに
おけるcanonical context textの正確なtoken数である。

## 12. Response and error contract

### 12.1 Domain statuses

```ts
type StructuredRetrievalStatus =
  | 'ok'
  | 'not_found'
  | 'stale_identity'
  | 'not_indexed'
  | 'excluded'
  | 'unsupported'
  | 'degraded'
  | 'stale'
  | 'index_incomplete';
```

| Status | Meaning |
| --- | --- |
| `ok` | Current working treeとの一致と要求complete sourceを検証済み |
| `not_found` | Fileまたはidentityを解決不能 |
| `stale_identity` | 過去に存在したIDがretired済み |
| `not_indexed` | Scope内・対応languageだがactive catalogなし |
| `excluded` | Existing ignore/scope規則の対象外 |
| `unsupported` | Structured parser対象外 |
| `degraded` | Parser/coverageが要求complete contractを保証不能 |
| `stale` | Active catalogとcurrent fileが不一致 |
| `index_incomplete` | 対象file generationまたはcross-store更新が未確定 |

### 12.2 Common trust metadata

```ts
interface RetrievalTrust {
  status: StructuredRetrievalStatus;
  freshness: 'fresh' | 'stale' | 'unknown';
  reindexRequired: boolean;
  sourceAvailable: boolean;
}
```

- `status: ok`は必ず`freshness: fresh`
- `stale`は必ず`sourceAvailable: false`
- Non-`ok` exact/context responseはsource fieldを持たない
- Hash値は通常responseへ露出しない
- Parser/index診断はstable `reasonCode`で返す
- Internal exception messageとstack traceは返さない

### 12.3 Expected domain outcomes versus MCP errors

Stale、unsupported、not found等は解釈可能なdomain outcomeとしてstructured responseを返す。
Tool call transport自体を失敗させない。ただし`status !== ok`であり、exact retrieval成功ではない。

次は既存方式の`isError: true`とstable `NEXUS_*` codeを使用する。

- Input schema違反
- Path traversalまたはsymlink escape
- SQLite/file I/O failure
- Storage unavailable
- Cancellation
- Internal invariant violation

## 13. Backward compatibility

### 13.1 Existing MCP contract

- `semantic_search`
- `grep_search`
- `hybrid_search`
- `get_context`
- `index_status`
- `reindex`

上記toolのexisting input、existing response field、ranking、既存利用方法を維持する。

`CodeChunk`へ`symbolId?: string`を追加する。Structured declaration由来の
semantic/hybrid resultだけが値を持つ。JSON clientは未知fieldを無視できる。

`get_context.symbolName`は予約項目のままとし、structured retrievalの挙動を追加しない。

### 13.2 Tool registration

新3 toolはexisting neutral schema registryからv1/v2 adapter双方へ登録する。
専用tool inputはstringとintegerで表現でき、既存neutral DSLの範囲内に収める。

### 13.3 Legacy index compatibility mode

Structured schema versionをSQLiteへ保存する。Old/missing schema検出時は次の挙動とする。

- 自動migrationしない
- 自動full rebuildしない
- Existing 6 toolは利用可能
- New 3 toolは`not_indexed`, `reindexRequired: true`
- `index_status.structuredIndex.status`は`reindex_required`
- Legacy LanceDB tableへのincremental writeはlegacy column setを維持する
- New `symbolId` columnをlegacy tableへ混在させない

Userはexisting `reindex({ fullRebuild: true })`を実行する。Full rebuildはnew LanceDB schemaと
structured catalogを同時に構築する。成功後にstructured schema versionをreadyとして保存する。

## 14. `index_status` extension

Existing responseへ任意`structuredIndex` fieldを追加する。

```ts
structuredIndex: {
  schemaVersion: 1;
  status: 'ready' | 'building' | 'reindex_required' | 'degraded';
  totalFiles: number;
  totalSymbols: number;
  exactFiles: number;
  degradedFiles: number;
  pendingFiles: number;
  reindexRequired: boolean;
}
```

Existing clientはこの追加fieldを無視できる。

## 15. Observability

Existing `nexus_tool_calls_total`と`nexus_tool_duration_seconds`は新toolも自動計測する。
Structured retrieval固有には次だけを追加する。

- Retrieval outcomes by tool/status
- Parser outcomes by language/status
- Context token count by tool
- Budget overflow count
- Catalog file/symbol count and parse coverage

File path、symbol ID、qualified nameをmetric labelへ含めない。Source codeやsignatureをlogへ
出力しない。

## 16. Performance validation

Existing benchmarkへstructured indexing/retrieval scenarioを追加する。

Datasetsは次とする。

- Nexus repository自身
- TypeScript/Python/Go mixed representative fixture
- 多数symbol、巨大class、overload、Unicodeを含むsynthetic repository

同一環境・同一datasetで変更前baselineと変更後を複数回測定し、中央値を比較する。

- Full/incremental indexing duration
- Parser duration
- SQLite/LanceDB storage size
- Semantic/hybrid/grep latency
- Outline/exact/context latency
- Event loop responsiveness

固定performance KPIは製品契約にしない。CorrectnessをCI hard gateとし、benchmark差分は
review可能なreportとして残す。Existing search/indexingに明確な悪化が見える場合は
release blockerとして原因を解消する。

## 17. Test strategy

### 17.1 Parser fixtures

Languageごとに次を検証する。

- Complete source byte range
- Decorator、JSDoc、Go doc comment、Python decorator
- Unrelated comment exclusion
- UTF-8/CJK/emoji byte offsets
- Qualified name、signature、parent-child
- Overload、same-name symbol、duplicate signature
- Import alias、namespace import、shadowing、ambiguous import
- Partial syntax error coverage
- Unsupported/fallbackがexact symbolを生成しないこと

### 17.2 Identity

- Body変更、line移動、周辺comment変更、reindexでID維持
- Rename、file move、signature変更でID変更
- OverloadごとにIDが異なる
- Canonical inputとversionのdeterminism
- Retired IDで類似symbolへfallbackしない

### 17.3 Storage contracts

SQLite implementationとtest doubleの双方へ同じcontract suiteを適用する。

- Generation stage/activate/rollback
- File replacement and delete
- Tombstone lifecycle
- Scope behavior
- Concurrent read/write
- Incomplete cross-store state

### 17.4 Retrieval service

- Fresh exact source
- Current file hash mismatchでsourceなし`stale`
- Symbol hash mismatchでsourceなし`index_incomplete`
- `not_found`, `stale_identity`, `excluded`, `degraded`
- Single buffer readからのhash verificationとbyte slice
- Symbolがbudget超過してもcomplete source維持
- Import-unit packing、budget omission、partial completeness
- Cancellation and path sanitization

### 17.5 MCP integration

- Search result `symbolId`から追加検索なしでexact source取得
- Split symbolの全chunkが同じIDを持ち、complete sourceへ戻る
- File outlineからsource/contextへ進む
- Embedding provider unavailableでもnew 3 toolが動作する
- v1/v2 neutral schema registration
- Existing 6 tool schemaとexisting response fieldが不変
- Excluded fileとparser failureのmachine-readable response

AC-1からAC-17をtest caseへ一対一でtraceする。

## 18. Agent guidance

次を更新する。

- `README.md`
- `SPEC.md`
- `docs/mcp-tools.md`
- `.agents/skills/code-search.md`

Updated workflowは次とする。

```text
semantic/hybrid result with symbolId
        ↓
get_symbol_source / get_symbol_context
```

```text
known file
        ↓
get_file_outline
        ↓
get_symbol_source / get_symbol_context
```

次ではexisting `get_context` flowを維持する。

- Arbitrary grep hit
- Line-oriented information
- Excluded/unsupported file
- Parserがexactnessを保証できないdeclaration

CodeGraph guidanceと責務境界は変更しない。

## 19. Surface-level acceptance QA

Compiler、lint、unit/integration tests、benchmarkとは別に、実際のMCP serverをclient経由で
操作する。

1. Searchからexact sourceを取得する。
2. Outlineからexact sourceを取得する。
3. Bounded contextを通常budgetで取得する。
4. Symbol自体がbudget超過するcaseでcomplete sourceを確認する。
5. Working tree編集後にsourceなし`stale`を確認する。
6. Reindex後に`fresh`へ復帰することを確認する。
7. Embedding unavailable時にstructured retrievalを確認する。
8. Unsupported/excluded fileのnon-success statusを確認する。

## 20. Rejected alternatives

### 20.1 LanceDB-centered symbol records

Search resultとの結合は単純になるが、logical symbol、outline、hierarchy、complete source、
freshnessがembedding/search storageへ密結合する。Split chunksとの1:N関係も不自然になるため
採用しない。

### 20.2 Retrieval-time reparse

Persistent metadataを減らせるが、毎回のparse cost、parser version差、overload resolution、
invalid identity handlingがretrieval pathへ流入する。Exactnessとlatencyを安定させにくいため
採用しない。

### 20.3 Extending `get_context`

Tool数は減るが、file/line retrievalとexact symbol retrievalでinput、response、failure semanticsが
混在する。Reserved `symbolName`の曖昧lookupもstable identity要件に合わないため採用しない。

### 20.4 Returning stale indexed source

Diagnostic utilityはあるが、callerがstatusを無視して古いsourceを利用できる。Retrieval honestyを
優先し、non-`ok` branchからsource fieldを除外する。

### 20.5 All-import fallback

Missing importを減らせるが、token効率を悪化させ、related importが完全に判定できたと誤認させる。
確実なbindingだけを返し、completenessを明示する。

## 21. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cross-store inconsistency | Generation stateとfail-closed response |
| Parser compatibility | Node 24対応packageをlockfileで固定 |
| Unicode offset mismatch | UTF-8 canonical offsetsとfixtures |
| Partial parseの過大評価 | Per-symbol trustとparse diagnostics |
| Stale source misuse | Non-`ok` responseからsourceを除外 |
| Token count ambiguity | Encoding、version、scopeを明示 |
| Metrics privacy/cardinality | Code identity/contentをlabelにしない |
| Legacy index breakage | Compatibility modeとexplicit full reindex |

## 22. Reference observations

Reference implementationのjCodeMunchは、file path、qualified name、kindを
基礎とするstable symbol ID、SQLite symbol metadata、raw source cache、
file outline、byte-range source retrieval、content hash verification、
freshness status、token-budgeted contextを提供している。

本設計はそのretrieval honestyとsymbol-centered flowを参考にするが、次をNexus固有に変更する。

- Public IDをversion付きopaque digestにする。
- Raw source cacheを追加せず、freshなworking-tree bytesを検証して読む。
- Existing Merkle/SQLite/LanceDB pipelineへgeneration stateを統合する。
- Stale時はindexed sourceを返さない。
- Related importsを確実なlexical bindingに限定する。
- Existing searchとCodeGraph responsibility boundaryを維持する。
