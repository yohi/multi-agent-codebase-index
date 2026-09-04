# Nexus Structured Symbol Retrieval 強化 — Requirements Brief

## 1. 対象

* 改修対象: `https://github.com/yohi/nexus`
* 対象ブランチ: `master`
* 比較・参考対象: `https://github.com/jgravelle/jcodemunch-mcp`
* 比較対象ブランチ: `main`
* 基準: 要件定義時点の各ブランチ現行実装
* 本文書の目的: `obra/superpowers` の `brainstorming` に入力するための要件定義
* 本文書ではアーキテクチャ、実装方式、ライブラリ選定、データ構造設計、具体的なMCP tool名、実装タスク分解は決定しない

---

## 2. 背景・課題

Nexus は現在、AI agent向けのlocal-first code indexing/search基盤として、semantic search、ripgrepによるexact search、AST-based chunking、file context retrievalを提供している。

現在の標準的な探索フローは概ね以下である。

```text
hybrid_search / grep_search
        ↓
candidate file + line range
        ↓
get_context
        ↓
partial file content
```

一方、jCodeMunchはcode retrievalをlogical symbol中心に扱い、

```text
search / file outline
        ↓
stable symbol identity
        ↓
exact symbol source
```

というretrieval pathを第一級の機能として提供している。

今回解決したい主問題は、Nexusの「関連コードを発見する能力」ではなく、**候補コード発見後のretrieval精度とtoken効率**である。

Agentが対象function / method / class等を発見した後も、現在はfile/line rangeを使ってcontextを取得する必要があり、検索用chunkの境界とlogical symbolの境界が一致する保証もない。

したがって、Nexusの既存hybrid/semantic discovery能力を維持したまま、

> **検索で見つけたlogical symbolを、一意に指定し、完全かつ検証可能なsourceとして、必要最小限のcontextとともに取得できること**

を実現したい。

---

## 3. リポジトリ上で確認できた現状

### 3.1 Nexus

Nexus v2は現在6つのMCP toolを公開しており、`semantic_search`はindexed `CodeChunk`を返し、`hybrid_search`はsemantic searchとgrepを統合したranking searchとして動作する。

`get_context`は`filePath`と任意の`startLine` / `endLine`によるfile content取得が中心であり、`symbolName`は現時点で「将来拡張用の予約項目」である。

現在のagent guidanceも、検索後に上位候補へ`get_context`を実行するOne-Call / Deferred Loading patternを推奨している。

### 3.2 Nexus内部のsymbol情報

Nexusの`CodeChunk`には現在以下が存在する。

* `id`
* `filePath`
* `content`
* `language`
* `symbolName`
* `symbolKind`
* `startLine`
* `endLine`
* `hash`

`ParsedDeclaration`にも`type`, `name`, `startLine`, `endLine`, `content`が存在する。

つまり、Nexusはすでにparserからdeclarationを抽出し、検索chunkへsymbol metadataを持たせる基盤を持っている。

一方、`Chunker`はdeclaration contentについても`maxChunkChars`に応じて複数chunkへ分割できる。

したがって現状では、

> **検索chunk = logical symbol**

とは限らない。

またparserが存在しない、declarationを抽出できない、またはparserが失敗した場合、fixed-line chunkingへfallbackする。

### 3.3 Nexusの既存`SymbolKind`

現在の`SymbolKind`には以下が存在する。

* `file`
* `module`
* `namespace`
* `class`
* `interface`
* `typeAlias`
* `enum`
* `function`
* `method`
* `property`
* `variable`
* `constant`
* `constructor`
* `import`
* `comment`
* `unknown`

今回のstructured retrievalでは、このうち既存parserがlogical declarationとして正しく抽出できるコードsymbolを対象とする。

### 3.4 jCodeMunchから参考にする能力

jCodeMunchは以下をretrievalの第一級概念として扱っている。

* stable symbol ID
* `get_file_outline`
* `get_symbol_source`
* symbol中心のcontext bundle
* token-budgeted context
* source verification
* freshness情報
* machine-readable retrieval trust signals

stable symbol IDはlogical symbolを再index後も参照できることを目的としており、file outlineからfull sourceを取得せずにsymbolを選択し、そのidentityを使ってexact sourceへ進める。

今回、これらをすべてNexusへ移植するわけではない。

---

## 4. 目的

### Primary Goal

Nexusを利用するAI agentが、semantic/hybrid search等で対象コードを発見した後、**file全体や検索chunkではなくlogical symbol単位で正確なsourceを取得できること**。

### Secondary Goal

上記retrievalを利用することで、agentが不要なfile contentをcontextへ投入する必要を減らすこと。

### 成功の考え方

token削減率の固定KPIは設定しない。

代わりに、代表的なコード探索で以下のretrieval flowが成立することを成功条件とする。

```text
hybrid/semantic search
        ↓
stable symbol identity
        ↓
exact symbol source
```

および、

```text
known file
        ↓
file-level symbol outline
        ↓
stable symbol identity
        ↓
exact symbol source
```

---

# 5. 機能要件

## FR-1. Logical symbolを第一級のretrieval対象として扱えること

Structured retrievalでは、検索index上の`CodeChunk`ではなくlogical declarationをretrieval単位として扱えること。

対象symbolが検索index内部で複数chunkへ分割されていても、callerがそのchunk境界を認識する必要があってはならない。

---

## FR-2. 1 symbol = 完全なlogical sourceを保証すること

Exact symbol retrievalでlogical symbolを指定した場合、そのsymbolの完全なsourceを取得できること。

検索index上のchunk sizeやchunk分割によってsymbol sourceが途中で切れてはならない。

例:

* function全体
* method全体
* class全体
* interface全体
* constructor全体

等。

---

## FR-3. Symbolに意味的に付随する宣言要素を完全sourceへ含めること

Logical symbolの意味・契約に直接属する以下のような要素は、そのsymbolの完全sourceに含まれること。

例:

* decorator
* annotation
* attribute
* declarationに結び付いたdoc comment

単にsource上で近接しているだけの無関係commentまで含める必要はない。

---

## FR-4. Stable symbol identityを持つこと

Structured retrieval対象symbolには、agentが一意に参照できるstable identityを持たせること。

identityは少なくとも、

```text
search result
    ↓
exact retrieval
```

および、

```text
file outline
    ↓
exact retrieval
```

の間で曖昧なく利用できること。

identityの具体的な文字列表現は本要件では規定しない。

---

## FR-5. Stable identityは通常のre-indexをまたいで維持されること

Logical symbolのidentityに関わる情報が変わっていない場合、

* symbol bodyの変更
* line numberの変更
* 周辺コードの変更
* re-index

によってidentityが変わらないこと。

以下までidentity維持を保証する必要はない。

* symbol rename
* file move
* logical identityそのものの変更

---

## FR-6. 同名symbolを一意に識別できること

同一file、class、namespace等に、

* 同名symbol
* overload
* 同じsymbol kind

が複数存在する場合も、それぞれのlogical declarationを一意に指定できること。

Disambiguationの具体方式は設計判断とする。

---

## FR-7. Invalid/stale identityで別symbolへ推測fallbackしないこと

指定されたstable identityに対応するlogical symbolが存在しなくなった場合、類似名、近接line、類似signature等から別symbolへ自動的に置き換えて成功扱いしてはならない。

Callerがmachine-readableに、

* identityが解決不能
* identityがstale

等を判定できること。

具体的なstatus名は設計判断とする。

---

## FR-8. Existing semantic/hybrid searchからstable identityへ直接進めること

`semantic_search`または`hybrid_search`の検索結果がstructured declaration由来のsymbolに対応している場合、その検索結果からstable symbol identityを取得できること。

Agentが検索結果の`symbolName`を使って再度symbol検索を行わなくても、

```text
search result → exact retrieval
```

へ進めること。

既存response fieldを破壊してはならない。

---

## FR-9. `grep_search`の任意text hitをsymbolへ解決することは必須としない

`grep_search`は引き続き、

* string
* error message
* comment
* config value
* arbitrary text

等の探索手段として利用できる。

任意のgrep hitについて包含symbolを解決してstable identityを付与することは、今回の必須要件ではない。

---

## FR-10. File-level symbol outlineを取得できること

既知fileについて、file全文を取得せず、そのfile内のretrieval対象symbolを確認できること。

File outlineでは少なくとも以下を取得できること。

* stable symbol identity
* `qualifiedName`
* symbol kind
* signature
* source上の位置
* parent/child relationship

例:

```text
Class
 ├─ constructor
 ├─ methodA
 └─ methodB
```

Full symbol sourceはoutlineへ含めない。

AI生成summaryも今回の必須要件にはしない。

---

## FR-11. Repo-wide outline / file-tree機能の追加は必須としない

今回必須とするoutlineはfile-levelのみとする。

以下の新規提供は今回の対象外。

* repository outline
* repository symbol map
* file tree browser

既存Nexusが持つ探索能力を利用する。

---

## FR-12. Bounded context retrievalを提供すること

Exact symbol sourceとは別に、symbolを中心としたbounded contextを取得できること。

最低保証するcontextは、

1. 対象symbolの完全source
2. 同一file内の関連imports

とする。

---

## FR-13. 関連importsは対象symbolが直接参照するものを優先すること

Bounded contextにおいて、file内すべてのimportsを無条件に含めることは要求しない。

対象symbolが直接参照するimportsを優先対象とすること。

関連性や完全性を確実に判定できない場合は、その状態をcallerがmachine-readableに認識できること。

必要なimportsがすべて含まれていると誤認させてはならない。

---

## FR-14. Bounded contextにtoken budgetを指定できること

Callerは周辺contextについてtoken budgetを指定できること。

Token budgetの具体的な計測方式・tokenizer等は設計判断とする。

---

## FR-15. Token budgetより対象symbolの完全性を優先すること

対象symbol自身が指定token budgetを超える場合でも、symbol sourceを途中で切ってはならない。

この場合、

* 対象symbolは完全に返す
* 周辺contextは原則抑制する
* requested budget
* actual usage
* budget超過状態

をmachine-readableに判定できること。

---

## FR-16. Exact retrieval結果に識別・検証metadataを含めること

Exact symbol retrieval結果では少なくとも以下をmachine-readableに取得できること。

* stable symbol identity
* `qualifiedName`
* symbol kind
* file path
* source position
* complete symbol source
* freshness / index consistency state

Bounded contextの場合は追加で、

* requested token budget
* actual token usage
* budget exceeded state

を取得できること。

具体的なresponse schemaは設計判断とする。

---

## FR-17. Freshness / index consistencyをmachine-readableに判定できること

Exact retrievalのsourceが現在のworking treeと整合しているか、agentが機械的に判断できること。

Stale sourceをfreshなexact retrievalとして黙って返してはならない。

---

## FR-18. Stale状態をexact retrieval成功として扱わないこと

Stable identity自体を解決できても、

```text
index state != current working-tree state
```

でありsourceの正確性を保証できない場合、exact retrievalを正常成功として扱ってはならない。

Callerが、

* stale
* re-index required

等に相当する状態をmachine-readableに判定できること。

具体的なfreshness判定方式やre-index方式は本要件では規定しない。

既存`get_context`等による通常file retrievalまで禁止するものではない。

---

## FR-19. Parserがexactnessを保証できない場合はdegraded/unavailableとすること

以下の場合、

* parser failure
* unsupported syntax
* declaration boundaryが不確実
* fixed-line fallbackしか利用できない

structured retrievalをexact成功として扱ってはならない。

Callerがstructured retrievalの信頼性不足または利用不能をmachine-readableに判定できること。

既存のgrep/file-range retrievalは引き続き利用可能でよい。

---

## FR-20. Structured retrieval対象symbol

現在Nexusの既存parserがlogical declarationとして正しく抽出できるコードsymbolを対象とする。

対象例:

* `module`
* `namespace`
* `class`
* `interface`
* `typeAlias`
* `enum`
* `function`
* `method`
* `property`
* `variable`
* `constant`
* `constructor`

以下は今回のexact symbol retrieval対象外とする。

* `file`
* `import`
* `comment`
* `unknown`

既存parserが実際にどのkindをdeclarationとして安全に扱えるかを優先する。

---

## FR-21. 現在structured declarationを抽出できる既存言語を対象とすること

今回の機能のために新しいprogramming language supportを追加することは目的としない。

現在Nexusのparserがstructured declarationを正しく抽出できる既存言語では、原則として同一のstructured retrieval契約を提供すること。

Fixed-line fallbackしか利用できないlanguage/fileはexact retrieval保証対象外であることを明示する。

---

## FR-22. Structured retrievalはsemantic/embedding機能に依存しないこと

Repositoryがstructured retrieval可能な状態までindex済みであれば、

* semantic searchが利用不能
* embedding providerが利用不能

であっても以下が利用可能であること。

* file-level symbol outline
* stable identityによるexact source retrieval
* bounded context retrieval

`semantic_search` / `hybrid_search`自体の障害時挙動を変更する要求ではない。

---

## FR-23. Structured retrievalのために新規外部サービスを必須としないこと

Structured retrievalはNexusがrepositoryをローカルにindex可能な環境で成立すること。

以下を新たな必須依存にしてはならない。

* external LLM API
* external embedding service
* remote code intelligence service

具体的な内部ライブラリ等は設計判断とする。

---

## FR-24. MCPから利用できること

今回追加するstructured retrieval能力はAI agentがMCP経由で利用可能であること。

少なくともMCPから、

* file-level outline
* stable symbol identity
* exact retrieval
* bounded context
* freshness / failure state

を利用できること。

同等機能をCLIへ追加することは今回の必須要件ではない。

---

## FR-25. Existing Nexus MCP contractを後方互換に保つこと

既存の主要MCP toolおよび既存利用方法を壊さないこと。

特に既存の、

* `semantic_search`
* `grep_search`
* `hybrid_search`
* `get_context`
* `index_status`
* `reindex`

を利用しているagent/clientが、今回の機能追加だけを理由に利用不能にならないこと。

Structured retrievalは既存retrieval pathを廃止するものではない。

---

## FR-26. Existing indexの再構築は許容する

今回必要となるstructured metadataの追加に伴い、upgrade後に既存repositoryのre-indexが必要になることは許容する。

以下は今回必須ではない。

* old index formatの無変換利用
* automatic index migration
* migration-free upgrade

Re-index後には既存MCP機能と新structured retrievalの双方が利用可能であること。

---

## FR-27. Existing index scope / ignore rulesを継承すること

Structured retrievalはNexusの既存index対象範囲と同じrepository scopeを使用すること。

既存ignore/exclude対象fileをstructured retrievalだけ独自にindexしてはならない。

対象外fileを指定した場合は、その状態をmachine-readableに判定できること。

Structured retrieval専用の別include/exclude体系は今回追加しない。

---

## FR-28. Agent-facing guidanceを更新すること

Nexusが提供する標準agent guidanceでは、structured symbol identityが得られる場合、

```text
hybrid/semantic search
        ↓
exact symbol retrieval
```

を省tokenな標準retrieval pathとして案内すること。

既知fileの場合は、

```text
file outline
        ↓
exact symbol retrieval
```

を案内すること。

一方、以下では既存`get_context` flowを維持する。

* arbitrary grep hit
* structured retrieval非対応file
* line-oriented information
* parserがexactnessを保証できない場合

既存CodeGraph guidanceも維持する。

---

# 6. 非機能要件

## NFR-1. Existing search/indexingに重大なperformance regressionを発生させないこと

今回の追加によって、既存の、

* `semantic_search`
* `hybrid_search`
* `grep_search`
* indexing

が実用上明確に悪化しないこと。

固定のlatency/index time/storage増加率は今回設定しない。

既存benchmarkまたは代表repositoryとの比較によって、重大なregressionがないことを確認可能であること。

---

## NFR-2. Retrieval honestyを優先すること

Structured retrievalは「それらしいコードを返す」ことより、取得結果の正確性を優先する。

Exactnessを保証できない場合、

* stale
* stale identity
* parser degraded
* unsupported
* not found

等を成功結果と明確に区別できること。

Status enumやschemaの具体形は設計判断とする。

---

## NFR-3. Token efficiencyを検証可能なbehaviorとして扱うこと

「○% token削減」の固定値は要求しない。

代わりに、代表的なsymbol-oriented explorationでfile全文を取得せず目的symbolへ到達できることを検証可能にする。

---

# 7. CodeGraphとの責務境界

今回、Nexusは **structured retrievalまで** を責務とする。

既存Nexus guidanceと同様、`.codegraph/`が存在するrepositoryでは、以下の高度な構造解析はCodeGraph側の責務として維持する。

今回Nexusへ取り込まないもの:

* call graph traversal
* call hierarchy
* dependency traversal
* blast radius
* impact analysis
* caller graph
* transitive dependency analysis

Bounded contextにcallersやtransitive dependenciesを必須で含めることもしない。

---

# 8. 対象外

今回の改修対象外は以下。

* jCodeMunchとの全面的なfeature parity
* repository-wide outline
* file tree機能の新設
* call graph
* blast radius
* class/call hierarchy intelligence
* dead-code analysis
* hotspot analysis
* refactoring planner
* change-to-symbol mapping
* symbol diff
* new programming language support
* AI-generated symbol summaries
* CLI版structured retrieval
* rename後のstable identity追跡
* file move後のstable identity追跡
* arbitrary grep hitからsymbolへの自動mapping保証
* automatic index migration
* fixed token削減率KPI
* 無関係なrefactoring

---

# 9. 主要受け入れ条件

## AC-1: Search → Exact retrieval

Structured declarationに対応する`semantic_search`または`hybrid_search`結果からstable symbol identityを取得できる。

そのidentityを使用し、追加の名前検索を行わず完全なlogical symbol sourceを取得できる。

---

## AC-2: Search chunk分割の隠蔽

1つのlogical symbolがindex内部で複数chunkに分割されていても、exact retrievalでは完全な1 symbolとして取得できる。

---

## AC-3: File outline → Exact retrieval

既知fileについてfull sourceを取得せずfile outlineを取得できる。

Outlineから対象symbolを選択し、そのstable identityを使って完全sourceを取得できる。

---

## AC-4: Outline information

File outlineから少なくとも、

* identity
* qualified name
* kind
* signature
* position
* parent-child relationship

を取得できる。

Outlineにfull sourceは含まれない。

---

## AC-5: Re-index stability

Symbol bodyやline numberのみを変更してre-indexしても、logical identityが変わっていなければstable identityは維持される。

---

## AC-6: Same-name disambiguation

同名overload等が複数存在しても、それぞれを別logical symbolとして指定して正しいsourceを取得できる。

---

## AC-7: Invalid identity safety

削除・rename等で旧identityが無効になった場合、類似symbolを自動取得せず、取得不能状態を機械判定できる。

---

## AC-8: Complete declaration source

Decorator / annotation / attribute / associated doc comment等、symbolに意味的に属する宣言要素を含めてsourceを取得できる。

---

## AC-9: Bounded context

対象symbolと関連importsをbounded contextとして取得できる。

対象symbolは常に完全である。

---

## AC-10: Token budget overflow

対象symbol自身がtoken budgetを超えるケースでもsymbol sourceを切断しない。

Callerがrequested budget、actual usage、overflow状態を判定できる。

---

## AC-11: Fresh result

Indexとworking treeが整合している場合、retrieval resultからfreshであることを機械判定できる。

---

## AC-12: Stale result

Working tree変更等によってexactnessを保証できない場合、古いsourceをfresh exact resultとして返さず、stale/re-index-required相当を判定できる。

---

## AC-13: Parser failure

Parser failure等によってlogical symbol boundaryを保証できないfileでは、fixed-line chunkをexact symbolとして返さず、structured retrieval unavailable/degradedを判定できる。

---

## AC-14: Embedding independence

Embedding providerを利用できない状態でも、structured indexが有効であれば、

* file outline
* exact symbol retrieval
* bounded context

を利用できる。

---

## AC-15: Backward compatibility

既存MCP利用者が従来のsearchおよび`get_context` flowを引き続き利用できる。

---

## AC-16: Retrieval scope consistency

既存Nexus index対象外fileはstructured retrievalでも対象外となり、その状態を明示的に判定できる。

---

## AC-17: Agent guidance

Nexus公式のagent-facing guidanceから、symbol-aware resultについて`search → exact symbol retrieval`を優先する方法を理解できる。

---

# 10. 既決事項

ユーザーとの要件ヒアリングで以下を確定済み。

1. Nexusはstructured retrievalまで担当する。
2. Call graph / blast radius等はCodeGraphへ委譲する。
3. 最優先課題は「検索後の正確・省tokenなsymbol retrieval」。
4. 既存MCP APIの後方互換性は必須。
5. 1 logical symbolは完全sourceとして取得できる。
6. Existing parserが扱うcode declarationを対象とする。
7. Stable symbol identityを必須とする。
8. Stable identityは通常のre-indexをまたいで維持する。
9. Stale sourceをfresh exact resultとして返さない。
10. Exact sourceとbounded contextの双方を提供する。
11. Token budgetよりsymbol完全性を優先する。
12. Bounded contextの最低保証はsymbol + related imports。
13. Semantic/hybrid search resultからstable identityへ直接進める。
14. File-level outlineを必須とする。
15. Outlineにはidentity / qualified name / kind / signature / position / hierarchyを含める。
16. Invalid identityで推測fallbackしない。
17. Token削減率の固定KPIは設けない。
18. Related importsは対象symbolの直接参照を優先する。
19. Symbolに意味的に付随するdeclaration metadata/sourceを含める。
20. Structured retrievalはsemantic/embedding availabilityに依存しない。
21. Exact retrievalはmachine-readable metadataを返す。
22. Parserがexactnessを保証できなければsuccess扱いしない。
23. 現在structured declarationを抽出できる既存言語を対象とする。
24. Overload等も一意に識別できる。
25. Stale indexではexact retrievalを正常成功扱いしない。
26. MCPを必須公開interfaceとする。
27. Existing search/indexingへの重大なperformance regressionを許容しない。
28. Existing indexのrebuildは許容する。
29. Structured retrievalのために新規external serviceを必須にしない。
30. Existing Nexus index scope / ignore rulesを継承する。
31. Agent-facing guidanceも改修対象とする。
32. Nexus `master` / jCodeMunch `main`を比較基準とする。

---

# 11. 設計フェーズへ委ねる事項

以下は要件として固定せず、superpowers `brainstorming`以降で判断する。

* stable symbol identityの具体的format
* overload disambiguation方式
* identity generation algorithm
* symbol metadataの保存形式
* metadata store / vector storeの変更方法
* exact sourceの保存・取得方式
* byte offsetを使うかどうか
* source hash方式
* freshness判定アルゴリズム
* freshness/status enumの名称
* MCP toolの具体的な名前・個数
* existing toolを拡張するか新toolを追加するか
* bounded contextのAPI shape
* token counting方式
* related import判定アルゴリズム
* signature抽出方式
* symbol hierarchyの内部表現
* languageごとのparser拡張方法
* performance benchmarkの具体的dataset
* test implementation方式
* migration/re-index UXの具体方式
* error schemaの詳細

---

# 12. 関連既存コード・仕様

調査時点で特に関連性が高い箇所。

### Nexus

* `src/indexer/chunker.ts`

  * AST declarationから`CodeChunk`を生成
  * `symbolName` / `symbolKind`を保持
  * `maxChunkChars`によるdeclaration分割
  * parser failure / declarationなしの場合のfixed-line fallback

* `src/types/index.ts`

  * `SymbolKind`
  * `CodeChunk`
  * `ParsedDeclaration`
  * `ParsedSourceFile`
  * `SearchResult`
  * `RankedResult`

* `docs/mcp-tools.md`

  * `semantic_search`
  * `grep_search`
  * `hybrid_search`
  * `get_context`
  * `index_status`
  * `reindex`

* `README.md`

  * current agent playbook
  * One-Call pattern
  * Deferred Loading
  * CodeGraphとの責務境界
  * index freshness/re-index guidance
  * existing ignore scope

* `.agents/skills/code-search.md`

  * agent-facing canonical code-search workflow
  * structured retrieval追加後に更新対象となる既存guidance

### jCodeMunch

参考にする主な仕様:

* stable symbol identity
* file-level outline
* exact symbol source retrieval
* bounded context retrieval
* token budget
* source verification
* freshness signaling
* retrieval honesty

参照:

* `ARCHITECTURE.md`
* `SPEC.md`
* `USER_GUIDE.md`

---

# 13. Superpowers brainstormingへの依頼

本要件を満たすための設計を検討すること。

特に以下の制約を守ること。

* Nexusのhybrid/semantic discovery能力は維持する。
* Existing MCP contractを破壊しない。
* Search chunkとlogical symbolを同一視しない。
* Exact retrievalではsymbol完全性を最優先する。
* Exactnessを保証できない状態をsuccessとして隠さない。
* CodeGraphの高度構造解析責務をNexusへ重複実装しない。
* Structured retrievalをembedding serviceへ依存させない。
* 新規language対応や無関係なrefactoringをスコープへ混ぜない。
* 本要件で未決の設計事項を、要件として既決だったかのように扱わない。
