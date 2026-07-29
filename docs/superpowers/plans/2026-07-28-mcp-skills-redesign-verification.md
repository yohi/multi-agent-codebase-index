# MCP Skills Redesign 手動検証シナリオ

Task 5 では、コード探索のトリガーに応じて `code-search.md` と適切な検索ツールが選択されることを、以下のシナリオで確認する。

## 1. Vague feature search

### User input: Vague feature search

> Where is the reindex logic implemented?

### Expected tool sequence: Vague feature search

1. `.agents/skills/code-search.md` をロードする。
2. Nexus の検索前提として `index_status` を呼び出す。
3. 曖昧な機能探索なので `hybrid_search` で `reindex` の実装候補を検索する。
4. 上位候補に対して `get_context` を `startLine` と `endLine` 付きで呼び出し、結果行の周辺を取得する。

依頼に対する主要経路は、`code-search.md` → `index_status` → `hybrid_search` → `get_context` である。

### Success criteria: Vague feature search

- `code-search.md` が検索実行前にロードされる。
- `grep_search` ではなく `hybrid_search` が選択される。
- 最終回答に、実装ファイルのパスと `get_context` で確認した行番号が含まれる。
- 検索結果の一覧だけで終わらず、取得したコード周辺に基づいてリインデックス処理の場所を説明できる。

## 2. Exact symbol trace

### User input: Exact symbol trace

> Who calls `executeHybridSearch`?

### Expected tool sequence: Exact symbol trace

1. `.agents/skills/code-search.md` をロードする。
2. Nexus の検索前提として `index_status` を呼び出す。
3. 正確なシンボル追跡なので `grep_search` で `executeHybridSearch` を検索する。
4. 呼び出し候補に対して `get_context` を `startLine` と `endLine` 付きで呼び出し、各 call site の周辺を取得する。

依頼に対する主要経路は、`code-search.md` → `index_status` →
`grep_search`（`executeHybridSearch`）→ `get_context` である。

### Success criteria: Exact symbol trace

- `code-search.md` が検索実行前にロードされる。
- `hybrid_search` ではなく `grep_search` に完全一致のシンボル名が渡される。
- 最終回答に、各呼び出し元のファイルパスと行番号が含まれる。
- 定義箇所だけでなく、`executeHybridSearch` を呼び出す call site を説明できる。

## 3. Structural call-tree request

### User input: Structural call-tree request

> Show me the dependency graph of the search module.

### Expected tool sequence: Structural call-tree request

1. `.agents/skills/code-search.md` をロードする。
2. プロジェクトに `.codegraph/` ディレクトリが存在するか確認する。
3. `.codegraph/` が存在する場合は、構造・依存関係の追跡に
   `codegraph_explore` を使う。必要に応じて `get_context` で根拠となる
   行範囲を取得する。
4. `.codegraph/` が存在しない場合は、Nexus の検索前提として
   `index_status` を呼び出し、`hybrid_search` で `search/` ディレクトリに
   関係する候補を探索する。
5. 候補取得後、`get_context` を `startLine` と `endLine` 付きで呼び出し、
   依存関係を構成する根拠となるコード周辺を取得する。

### Success criteria: Structural call-tree request

- `.codegraph/` の有無に応じてツールが分岐する。
- `.codegraph/` が存在する場合、`codegraph_explore` が構造探索に使われる。
- `.codegraph/` が存在しない場合、`codegraph_explore` を呼び出さず
  `hybrid_search` で `search/` を探索する。
- 最終回答に、検索モジュールの依存関係を示す呼び出し元・呼び出し先
  またはファイル関係と、その根拠となるパスが含まれる。
