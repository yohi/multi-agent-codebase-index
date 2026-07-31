# 2026-07-31 SPEC §6.6 Future Work 実装設計書

> Brainstorming スキルに基づく設計。承認済みの設計分岐: 両拡張を 1 プラン / スニペットは結果オブジェクト内 / deferred の概要は「行数+先頭プレビュー+案内」/ 有効化は `mode: "deferred"`。

## 目的

SPEC.md §6.6 に記載された 2 つの MCP API 拡張を後方互換で実装する。

1. `hybrid_search` のスニペット付き応答オプション — 1 回の呼び出しでランキング結果＋前後コードスニペットを返す
2. `get_context` の Deferred Loading モード — 長大ファイル向けに「概要＋行番号＋追加取得案内」を返すオプトインモード

## 設計原則

- **後方互換**: 新規パラメータはすべて optional。未指定時の挙動は現行と完全に同一。
- **必須キー不変**: 既存 `inputSchema` の required 配列・既存プロパティの意味は変更しない。
- **レスポンス契約の分離**: `get_context` は `mode` を判別子とする discriminated union として eager / deferred のレスポンス契約を分離する。`mode` 未指定時は eager 契約を維持し、既存呼び出しのレスポンス形状は不変。
- **破壊的変更ゼロ**: 既存呼び出しのレスポンス shape に新フィールドのみ追加。既存フィールドの型・意味は不変。

## Task 1: 共有スニペットヘルパー抽出

`get-context.ts` のクランプ＋スライスロジックを独立した関数として切り出す。

**対象ファイル**: `src/server/tools/get-context.ts`

**公開インターフェース**（後続 Task が依存）:

```ts
export interface LineRange {
  startLine: number;
  endLine: number;
}

/** 行番号をファイル行数にクランプし、範囲逆転時は null を返す。 */
export const resolveLineRange = (totalLines: number, startLine?: number, endLine?: number): LineRange | null;

/** コンテンツから指定範囲を切り出す。1-indexed, inclusive。 */
export const sliceContent = (content: string, range: LineRange): string;
```

`executeGetContext` はこれらヘルパーを使うように内部実装だけ置き換え、公開挙動は不変。

## Task 2: `hybrid_search` スニペット拡張

### 入力スキーマ追加（optional）

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `includeSnippet` | boolean | `false` | true で結果にスニペット付与 |
| `contextLines` | positive int | `3` | chunk 前後の取得行数（clamping 対象） |

`contextLines` は `includeSnippet=true` 時のみ意味を持つ。`includeSnippet` 未指定/ false 時はレスポンスにスニペットフィールドを含めない（未指定時レスポンス不変を厳密に守るため）。

### レスポンス拡張

各 `RankedResult` に optional で追加:

```ts
snippet?: string;           // 前後行を含むスニペット本文
snippetStartLine?: number;  // スニペット開始行（1-indexed）
snippetEndLine?: number;    // スニペット終了行（1-indexed）
```

トップレベル `SearchResponse` は不変（`query` / `results` / `tookMs`）。

読込失敗した結果は `snippet` / `snippetStartLine` / `snippetEndLine` を含まず、それ以外の `chunk` / `score` / `source` / `rank` / `reciprocalRankScore` は維持される。

### 実装

- `executeHybridSearch` に `loadFileContent` を注入（factory で既存 injector をそのまま渡す）。
- スニペット付加は `SearchOrchestrator` の外側（ツール層）で実施。`SearchOrchestrator` と RRF ロジックは非接触。
- 対象結果は `topK` 適用後の `results` のみ（デフォルト上位 20 件）。
- **同一ファイル読込キャッシュ**: `sanitizer.sanitize(chunk.filePath)` で解決したサニタイズ済みパスをキーとする `Map<string, string | null>` を1回の呼び出し内で保持し、同一ファイルから複数の chunk をスニペット化する場合でも `loadFileContent` は1回だけ呼ぶ。ファイル読込失敗（ENOENT 等）はキャッシュに `null` を記録し、スニペットのみスキップして検索結果は返す（graceful degradation）。
- 結果ごとに Task 1 のヘルパーで `chunk.startLine - contextLines` 〜 `chunk.endLine + contextLines` を抽出。
- `abortSignal` は既に orchestrator に伝播済み。スニペット読込でも中断を尊重（abort 時は以後の読込を停止）。
- `contextLines` の上限は定数 `MAX_CONTEXT_LINES = 20` でクランプ（I/O 増幅対策）。JSON Schema は positive int のみを宣言し、ハンドラ側で clamp。

### 検索パラメータとの分離

`includeSnippet` / `contextLines` は表示専用で、`SemanticSearchParams` には絶対に流さない。`executeHybridSearch` 内で `filePattern` と同様に分離してから orchestrator に渡す。

## Task 3: `get_context` Deferred Loading

### 入力スキーマ追加（optional）

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"eager" \| "deferred"` | `"eager"` | deferred で概要応答 |

`mode` 省略時（= `"eager"`）は現行挙動を完全に維持。`mode: "deferred"` 時は `content` / `startLine` / `endLine` を返さない代わりに概要フィールドを返す。

### レスポンス契約

`get_context` は `mode` を判別子とする discriminated union としてレスポンスを返す。

- eager 時（`mode` 未指定含む）:

  ```ts
  {
    filePath: string;
    content: string;
    startLine: number;
    endLine: number;
  }
  ```

  既存の required フィールド（`content` / `startLine` / `endLine`）は維持される。

- deferred 時:

  ```json
  {
    "filePath": "src/auth.ts",
    "mode": "deferred",
    "totalLines": 1234,
    "summary": "…先頭プレビュー…",
    "previewStartLine": 1,
    "previewEndLine": 20,
    "hint": "Call get_context with startLine/endLine to fetch specific ranges."
  }
  ```

  この variant には `content` / `startLine` / `endLine` は含まれない。

### Deferred 時の summary 範囲

- `startLine` / `endLine` が両方指定されている場合、`summary` はその要求範囲のプレビューとする。`previewStartLine` / `previewEndLine` は要求範囲をファイル境界にクランプした実際の範囲とする。要求範囲が逆転している場合は既存の eager 契約と同じくエラーとする。
- `startLine` のみ指定された場合、プレビュー範囲は `startLine` から `min(startLine + PREVIEW_LINES - 1, totalLines)` までとする。
- `endLine` のみ指定された場合、プレビュー範囲は `max(1, endLine - PREVIEW_LINES + 1)` から `endLine` までとする。
- 両方未指定時のデフォルトはファイル先頭 `PREVIEW_LINES = 20` 行。
- いずれの場合も `totalLines` はファイル全体の行数を表す。
- `hint` の文言は定数で統一。取得案内は `get_context` 自体の再呼び出しを導く形にする（外部コマンド案内はしない＝ローカル完結維持）。

### 内部実装

`executeGetContext` 内でモード分岐。deferred でも既存と同じく全文を `loadFileContent` する（現在の `readFile` ベースの注入ではストリーミング読みしないが、レスポンス削減という主目的は達成できる）。将来の読込最適化は本設計の対象外。

## Task 4: スキーマ固定テスト・ドキュメント更新

### テスト

- `tests/integration/mcp-protocol.test.ts`: `inputSchema.properties` キー集合を更新
  - `hybrid_search`: `['contextLines', 'filePattern', 'filePatterns', 'grepPattern', 'includeSnippet', 'language', 'query', 'topK']`
  - `get_context`: `['endLine', 'filePath', 'mode', 'startLine', 'symbolName']`
  - デフォルト動作（新パラメータなし）のレスポンスが現行通りであることを既存アサーションで担保
  - 追加: `mode: "deferred"` で `mode` / `totalLines` / `hint` を含み `content` を含まないことを integration テストで確認
- `tests/unit/server/tools/hybrid-search.test.ts`: `includeSnippet` 前後、`contextLines` クランプ（> 20 → 20）、同一ファイルの複数結果に対する読込キャッシュ、パラメータが orchestrator に漏れないこと、読込失敗時の graceful degradation
- `tests/unit/server/tools/get-context.test.ts`: eager 不変、deferred のレスポンス shape、deferred + range 指定時のプレビュー範囲、`totalLines`、preview クランプ（20 行未満のファイル）

### ドキュメント

- `docs/mcp-tools.md`: 両ツールの新パラメータ・レスポンス例・デフォルト挙動を追記
- `SPEC.md` §6.6: 「今後の拡張」から「実装済み仕様」へ書き換え（§6.3 の One-Call が API 化された旨の言及）
- `.agents/skills/code-search.md`: One-Call / Deferred Loading の節に、サーバー側 API が利用可能になった旨を追記し、既存の手続きとの関係を明確化
- `README.md`: ツール表は簡潔のまま変更せず、詳細は `docs/mcp-tools.md` 参照を維持（必要なら一言追記に留める）

## エラーハンドリング方針

- `get_context` の範囲逆転エラーは現行どおり throw（`errorResult` で `isError: true`）。
- `contextLines` 非正整数は Zod schema が拒否。上限超過は clamp（エラーにしない）。
- `includeSnippet=true` かつ `contextLines` 未指定の場合、`contextLines` は `3` として動作する。`includeSnippet=false`（または未指定）時はスニペットフィールドはレスポンスに含まれない。
- 読込失敗した結果は `snippet` / `snippetStartLine` / `snippetEndLine` を含まず、それ以外の `chunk` / `score` / `source` / `rank` / `reciprocalRankScore` は維持される。

## メトリクス方針

- スニペット行数は新メトリクスを増やさず、既存 `nexus_context_lines_fetched_total` を使用する。
  - `get_context` は `tool_name="get_context"` で計上（変更なし）。
  - `hybrid_search` は `tool_name="hybrid_search"` で1回の検索呼び出しにつき**1回** `onContextLinesFetched` を呼び出す。計上する行数は、各結果のスニペット範囲を重複排除してマージした総行数（読込失敗したファイルは除外）。これにより複数結果が同一ファイルにまたがる場合でも実際に取得したユニーク行数を計上する。
  - deferred 時は `previewEndLine - previewStartLine + 1` 行を `tool_name="get_context"` で計上。

## 非目標 (Out of Scope)

- `get_context` のストリーミング読み込みへの変更
- `semantic_search` / `grep_search` へのスニペット拡張
- シンボル一覧を含む高度な概要生成
- `tools/list_changed` 通知（サーバーは既に `capabilities.tools.listChanged: true` を宣言済み。クライアントへの既知配慮はドキュメント記載に留める）

## 検証

1. `npx vitest run tests/unit/server/tools/hybrid-search.test.ts tests/unit/server/tools/get-context.test.ts`
2. `npx vitest run tests/integration/mcp-protocol.test.ts`
3. `npm run lint`
4. `npx vitest run`（全体）

## 分岐解決ログ（承認済み）

| 論点 | 決定 |
| --- | --- |
| 分割方針 | 両拡張を 1 プラン |
| スニペット位置 | 結果オブジェクト内 (`RankedResult.snippet`) |
| 概要の内容 | 行数 + 先頭プレビュー + 案内 |
| 有効化 API | `mode: "deferred"` |
