# MCP ツールリファレンス

Nexus は `createNexusServer()` を通じて 9 つの MCP ツールを公開します。
すべてのレスポンスは structured JSON content として返されます。

## ツール一覧

| ツール名 | 用途 |
| --- | --- |
| `semantic_search` | ベクトル検索による意味的なコード探索 |
| `grep_search` | ripgrep を用いた正確な文字列検索 |
| `hybrid_search` | セマンティックと grep を組み合わせた強力な検索 |
| `get_context` | ファイルの指定範囲のコードをコンテキストとして取得 |
| `get_file_outline` | 既知ファイルのシンボル・アウトラインを取得 |
| `get_symbol_source` | 構造化シンボル ID の正確なソースを取得 |
| `get_symbol_context` | 構造化シンボル ID の検証済み関連コンテキストを取得 |
| `index_status` | インデックス進捗や統計情報の確認 |
| `reindex` | インデックスの手動再作成 |

### 構造化 symbol 検索フロー

`semantic_search` / `hybrid_search` の結果に `chunk.symbolId` が含まれる場合、
その ID を使って `get_symbol_source` または `get_symbol_context` で正確なソースや
関連コンテキストを取得できます。

```text
semantic_search / hybrid_search result with symbolId
  -> get_symbol_source or get_symbol_context

known supported file
  -> get_file_outline
  -> get_symbol_source or get_symbol_context
```

grep ヒットや行指向のリクエスト、未対応・不確実な宣言、インデックス対象外の
ファイルについては、従来どおり `get_context` を使用してください。

構造化検索を有効にするには、`reindex({ fullRebuild: true })` で明示的に
フルリビルドしてください。レガシーインデックスは自動移行されず、
構造化ツールは `reindex_required` / `not_indexed` ステータスでゲートされます。

インデックス済みコードチャンクに対する vector similarity search です。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | 自然言語またはコード寄りの検索クエリ |
| `topK` | positive integer | no | 返す最大件数 |
| `filePattern` | string | no | 任意の file glob filter |
| `filePatterns` | string[] | no | 複数の file glob filter（`filePattern` と同時に指定可能） |
| `language` | string | no | 任意の言語 filter |

### レスポンス

```json
{
  "results": [
    {
      "chunk": {
        "id": "src/auth.ts:1",
        "filePath": "src/auth.ts",
        "content": "export function authenticate() {}",
        "language": "typescript",
        "symbolKind": "function",
        "startLine": 1,
        "endLine": 1,
        "hash": "hash-1"
      },
      "score": 0.98,
      "source": "semantic"
    }
  ]
}
```

## `grep_search`

設定済み project directory を起点にした ripgrep ベースの exact text search です。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | string | yes | grep engine へ渡す text または regex pattern |
| `filePattern` | string | no | 任意の file glob filter |
| `filePatterns` | string[] | no | 複数の file glob filter（`filePattern` と同時に指定可能） |
| `caseSensitive` | boolean | no | case-sensitive match を有効化 |
| `maxResults` | positive integer | no | 返す最大 match 数 |

### レスポンス

```json
{
  "matches": [
    {
      "filePath": "src/auth.ts",
      "lineNumber": 1,
      "lineText": "export function authenticate() {}",
      "submatches": [
        {
          "start": 16,
          "end": 28,
          "match": "authenticate"
        }
      ]
    }
  ]
}
```

## `hybrid_search`

semantic search と grep search を統合した ranking search です。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | ranking の主クエリ |
| `topK` | positive integer | no | 返す最大件数 |
| `filePattern` | string | no | 任意の file glob filter |
| `filePatterns` | string[] | no | 複数の file glob filter（`filePattern` と同時に指定可能） |
| `language` | string | no | 任意の言語 filter |
| `grepPattern` | string | no | ranking に混ぜる exact-match 用クエリ |
| `includeSnippet` | boolean | no | `true` の場合、各結果に前後のコードスニペットを添付する |
| `contextLines` | positive integer | no | スニペットに含める前後の行数。省略時は 3、20 を超える値は 20 にクランプされる |

### 挙動

- `includeSnippet` が `true` の場合、各結果の `chunk.startLine`/`endLine` を中心に前後 `contextLines` 行（デフォルト 3、最大 20）を含むコードスニペットを取得し、`snippet` / `snippetStartLine` / `snippetEndLine` を各結果へ追加します。
- ファイルの読み込みまたは path sanitization に失敗した結果は、その結果のみスニペットを省略して処理を継続します（検索結果全体は失敗しません）。
- `includeSnippet` を省略または `false` にした場合、レスポンス形状は変わりません。

### レスポンス

```json
{
  "query": "authenticate token",
  "results": [
    {
      "chunk": {
        "filePath": "src/auth.ts"
      },
      "score": 1,
      "source": "hybrid",
      "rank": 1,
      "reciprocalRankScore": 0.03278688524590164
    }
  ],
  "tookMs": 4
}
```

`includeSnippet: true` を指定した場合、各結果に以下のフィールドが追加されます:

```json
{
  "snippet": "export function authenticate() {}\n// ...",
  "snippetStartLine": 1,
  "snippetEndLine": 4
}
```

## `get_context`

指定した行範囲の file content を返します。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `filePath` | string | yes | project-relative file path |
| `symbolName` | string | no | 将来拡張用の予約項目 |
| `startLine` | positive integer | no | file bounds に clamp される開始行 |
| `endLine` | positive integer | no | file bounds に clamp される終了行 |
| `mode` | `"eager"` \| `"deferred"` | no | デフォルトは `"eager"`。`"deferred"` の場合は全文の代わりに要約プレビューを返す |

### 挙動

- path は server-side path sanitizer を通して解決されます。
- `startLine` と `endLine` を両方省略した場合はファイル全体を返します。片方のみ指定した場合は、指定した行からファイルの対応する境界（先頭または末尾）までの範囲を返します（`startLine` のみ指定 → 指定行〜ファイル末尾、`endLine` のみ指定 → ファイル先頭〜指定行）。
- 解決後の開始行が終了行を上回る場合はエラーになります。
- `mode: "deferred"` を指定すると、`content` の代わりに `mode`, `totalLines`, `summary`, `previewStartLine`, `previewEndLine`, `hint` を含む要約レスポンスを返します（大きなファイルを一括で読み込ませないための機能）。
- deferred モードのプレビュー範囲は次の規則で決まります: `startLine` と `endLine` を両方指定した場合はその範囲（file bounds にクランプ）。`startLine` のみの場合は `startLine` から最大 20 行。`endLine` のみの場合は `endLine` までの直前最大 20 行。両方省略した場合はファイル先頭から最大 20 行。
- `hint` フィールドには、必要な範囲を `startLine`/`endLine` で指定して再度 `get_context` を呼び出すよう案内する文字列が含まれます。

### レスポンス

```json
{
  "filePath": "src/auth.ts",
  "content": "export function authenticate() {}",
  "startLine": 1,
  "endLine": 1
}
```

`mode: "deferred"` を指定した場合のレスポンス例:

```json
{
  "filePath": "src/auth.ts",
  "mode": "deferred",
  "totalLines": 500,
  "summary": "export function authenticate() {}\n// ...",
  "previewStartLine": 1,
  "previewEndLine": 20,
  "hint": "Call get_context with startLine/endLine to fetch specific ranges."
}
```

## `get_file_outline`

既知の対応ファイルのアクティブなシンボル・アウトラインを返します。
構造化インデックスが有効で、かつファイルの現在のバイトがインデックス時と一致する場合に
`ok` ステータスでソースフリーのメタデータを返します。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `filePath` | string | yes | project-relative file path |

### レスポンス

```json
{
  "filePath": "src/auth.ts",
  "status": "ok",
  "symbols": [
    {
      "symbolId": "symbol_v1_abc...",
      "qualifiedName": "AuthService.authenticate",
      "kind": "method",
      "signature": "authenticate(token: string): Promise<User>",
      "startLine": 12,
      "endLine": 18,
      "parentKey": "AuthService"
    }
  ]
}
```

非 `ok` ステータスでは `symbols` キーは含まれません。主なステータスと reasonCode:

| status | reasonCode | 意味 |
| --- | --- | --- |
| `ok` | — | 新鮮なアウトラインを返す |
| `not_indexed` | `STRUCTURED_INDEX_MISSING` / `UNSUPPORTED_LANGUAGE` / `PATH_EXCLUDED` | 構造化インデックス未構築、未対応言語、対象外パス |
| `stale` | `INDEX_FILE_HASH_MISMATCH` / `INDEX_FILE_MISSING` | ファイルが変更または削除された |
| `index_incomplete` | `INDEX_PENDING_GENERATION` | ファイルの世代が活性化待ち |

## `get_symbol_source`

構造化シンボル ID の正確なソースを返します。成功時のみ `source` キーが含まれます。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `symbolId` | string | yes | `symbol_v1_<base64url-sha256>` 形式の ID |

### レスポンス

```json
{
  "symbolId": "symbol_v1_abc...",
  "status": "ok",
  "freshness": "fresh",
  "source": "export async function authenticate(token: string): Promise<User> { ... }"
}
```

非 `ok` 時は `source` キーを含みません。`stale_identity` ステータスは退役した ID に対して返されます。

## `get_symbol_context`

構造化シンボル ID の検証済み関連 import と正確なシンボルソースを返します。
`tokenBudget` は関連 import の選択にのみ適用され、シンボルソース自体は常に完全に返されます。
import の追加で予算を超過した場合、`budget.exceeded: true` と `omittedForBudget` カウントで報告します。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `symbolId` | string | yes | `symbol_v1_<base64url-sha256>` 形式の ID |
| `tokenBudget` | integer | yes | 1 〜 100000 のトークン上限 |

### レスポンス

```json
{
  "symbolId": "symbol_v1_abc...",
  "status": "ok",
  "freshness": "fresh",
  "context": "import { User } from \"./user.js\";\n\nexport async function authenticate(token: string): Promise<User> { ... }",
  "imports": [
    { "moduleSpecifier": "./user.js", "bindingName": "User", "completeness": "complete" }
  ],
  "budget": {
    "requested": 2000,
    "actual": 42,
    "exceeded": false,
    "omittedForBudget": 0
  },
  "tokenizer": "cl100k_base",
  "tokenizerVersion": "js-tiktoken@1.0.21"
}
```

予算を超えてもシンボルソースは常に完全に返されます。超過時は `budget.exceeded: true` となり、
収まらなかった import が `omittedForBudget` にカウントされます。

## `index_status`

現在の metadata、vector、plugin health 情報を返します。

### 引数

このツールは空オブジェクトを受け取ります。

### レスポンス

```json
{
  "indexStats": {
    "id": "primary",
    "totalFiles": 1,
    "totalChunks": 1,
    "lastIndexedAt": "2026-04-07T00:00:00.000Z",
    "lastFullScanAt": null,
    "overflowCount": 0,
    "lastError": null
  },
  "vectorStats": {
    "totalChunks": 1,
    "totalFiles": 1,
    "dimensions": 64,
    "fragmentationRatio": 0,
    "lastCompactedAt": null
  },
  "skippedFiles": 0,
  "pipelineProgress": {
    "totalFiles": 1,
    "processedFiles": 1,
    "status": "idle"
  },
  "pluginHealth": {
    "languages": {
      "registered": [
        "typescript",
        "python",
        "go"
      ],
      "healthy": true
    },
    "embeddings": {
      "provider": "ollama",
      "healthy": true
    },
    "healthy": true,
    "isOperational": true
  },
  "structuredIndex": {
    "schemaVersion": 1,
    "targetSchemaVersion": 1,
    "status": "idle",
    "rebuildState": null,
    "lastErrorCode": null,
    "totalFiles": 12,
    "totalSymbols": 87,
    "exactFiles": 10,
    "degradedFiles": 2,
    "pendingFiles": 0,
    "reindexRequired": false
  }
}
```

`structuredIndex` は省略可能です。レガシーインデックスでは `schemaVersion: null`、
`status: "reindex_required"`、`reindexRequired: true` となります。
構造化インデックスを有効にするには `reindex({ fullRebuild: true })` を実行してください。

`indexStats` が `null`、`indexStats.lastIndexedAt` が `null`、または `indexStats.lastError` が non-null の場合、そのプロジェクトには成功済みリインデックスの記録がありません。
通常サービス起動では、この状態に対してバックグラウンド Full Index が一度だけ開始されます。

`pipelineProgress.status === "running"` はインデックス処理中であることを示しますが、検索は利用できます。
成功済みのインデックスは `indexStats.lastIndexedAt` が非nullかつ `indexStats.lastError` が null であることにより判断してください。
`pipelineProgress.lastError` は現在のプロセスにおける診断情報として併せて参照できます。
DLQ 残存などで `lastError` が設定された場合でも、処理終了後の `status` は `"idle"` になるため、status 単独では成功を判定できません。
`skippedFiles` は現在の永続 DLQ エントリ数です。

#### `pipelineProgress` と `skippedFiles` の契約

| Field | Type | Description |
| --- | --- | --- |
| `pipelineProgress.totalFiles` | number | 現在のリインデックス対象ファイル数 |
| `pipelineProgress.processedFiles` | number | 現在までに処理したファイル数 |
| `pipelineProgress.currentFile` | string | 処理中のファイル。未設定時はレスポンスから省略 |
| `pipelineProgress.status` | `"idle"` \| `"running"` \| `"stopping"` | パイプライン状態 |
| `pipelineProgress.lastError` | string | 現在のプロセスにおける失敗内容。未設定時はレスポンスから省略 |
| `skippedFiles` | number | Metadata Store に永続化された DLQ エントリ数 |

処理中は次のように `currentFile` と `status: "running"` が設定されます。

```json
{
  "skippedFiles": 0,
  "pipelineProgress": {
    "totalFiles": 120,
    "processedFiles": 42,
    "currentFile": "src/auth.ts",
    "status": "running"
  }
}
```

DLQ が残った場合は処理終了後に `status: "idle"` へ戻り、`lastError` と `skippedFiles` で不完全状態を示します。

```json
{
  "skippedFiles": 2,
  "pipelineProgress": {
    "totalFiles": 120,
    "processedFiles": 120,
    "status": "idle",
    "lastError": "Full reindex incomplete: 2 dead-letter queue item(s) remain"
  }
}
```

## `reindex`

indexing pipeline を通じて manual reindex を実行します。

### 引数

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `fullRebuild` | boolean | no | incremental pass ではなく full rebuild を要求 |
| `reason` | `manual` \| `overflow-recovery` \| `startup-reconciliation` | no | 再インデックスの起点。省略時は `manual` |

### レスポンス

成功時のレスポンス形状は pipeline の reindex result に従います。手動・起動時自動・overflow recovery のいずれも、
DLQ が空の場合だけ `index_stats` の完了状態を保存します。
すでに reindex が実行中の場合は、次を返します。

```json
{
  "status": "already_running"
}
```

DLQ に残存エントリがあるため完了状態を保存できなかった場合は、次を返します。`index_stats` は更新されません。

この場合 `pipelineProgress.lastError` には安定メッセージ
`Full reindex incomplete: <count> dead-letter queue item(s) remain`
が設定されるため、クライアントはこれで不完全完了を判定できます。

```json
{
  "status": "incomplete"
}
```

- `1 MB` を超える request body は HTTP transport 層で reject されます。

## stdio-only クライアント向け HTTP Bridge

stdio 接続のみに対応した MCP クライアント（OpenCode など）から、Nexus HTTP サーバーに接続するには、`nexus http-bridge` を中継として使います。Bridge は独立したローカルプロセスとして起動し、標準入出力の JSON-RPC を Nexus の Streamable HTTP エンドポイントに転送します。

### 使い方

基本的な接続は引数なしで実行できます。

```bash
nexus http-bridge
```

同じプロジェクトに対しては常に 1 つの Nexus HTTP サーバーが共有されます。初回の Bridge 接続時にまだ HTTP サーバーが起動していなければ、OS 割当のループバックポートで自動起動します。全 MCP クライアントが切断すると、HTTP サーバーは自動的に停止し、プロジェクトの `endpoint.json` 記述子も削除されます。これは managed HTTP 経路の説明であり、直接起動する `nexus serve` は MCP セッションを保持しない stateless v2 HTTP 経路です。

managed server の descriptor は `<storage.rootDir>/endpoint.json` に保存され、`instanceId`（起動ごとのランダム UUID）、`pid`、`projectRoot`、`url` を含みます。managed server の descriptor health check は `127.0.0.1` のみを受け付ける loopback-only 制限です。コネクターは、descriptor の `projectRoot` 一致、`url` が `127.0.0.1`（ループバック）であること、`pid` の生存、`GET /health` が同一 `instanceId`/`projectRoot` を返すこと、というすべての条件で健全性を判定し、いずれかを満たさない場合は descriptor を削除して再起動候補とします。起動が競合した場合、グローバル起動ロックを取得できなかった側のコネクターは新規プロセスを起動せず、取得側が公開する descriptor をポーリングで待ち受けて同じ URL に接続します。`127.0.0.1` 以外を指す URL は健全とは判定されないため、本機能はループバックのみを対象とし、ネットワーク公開や systemd 等の外部プロセス管理には依存しません。

同一プロジェクトに対して複数の MCP クライアントが同時に接続できます。各クライアントは独立した MCP transport/server instance（接続ライフサイクル）を持ちますが、SQLite・LanceDB・File Watcher は 1 つの managed server プロセスに集約されます。ここでの「セッション」はクライアント接続を追跡する単位であり、クライアントごとにインデックス状態を複製するアプリケーション状態を意味しません。アクティブなクライアントが 0 になると、managed server は runtime を閉じて descriptor とプロセスロックを削除し終了します（`--idle-shutdown-ms` / `NEXUS_IDLE_SHUTDOWN_MS` で遅延を調整可能、デフォルト `0`）。起動後 30 秒以内にクライアントが 1 つも接続しない場合も同様に自動終了します。

> **トラブルシューティング**: `nexus http-bridge` 自体も、descriptor が既定のタイムアウト（30 秒）以内に健全な状態で公開されない場合、原因を標準エラー出力（stderr）に書き込んで異常終了します。接続がハングする場合は、stderr のログを確認してください。

### プロジェクトルートの指定

managed server の descriptor 保存先やロック名は `storage.rootDir`（既定では `<projectRoot>/.nexus`）から導出されます。`.nexus.json` などでカスタムの保存先を設定している場合は、その値が使用されます。カレントディレクトリ以外のプロジェクトルートを対象にする場合は `--project-root <path>` 引数または `NEXUS_PROJECT_ROOT` 環境変数を指定してください。

```bash
nexus http-bridge --project-root /path/to/project
```

### URL の指定方法

明示的 URL モード（`--url` 引数または `NEXUS_BRIDGE_URL` 環境変数）は、外部サービスへ接続できる例外です。このモードでは自動起動と descriptor 検証をスキップし、指定した URL にのみ接続します。

```text
--url > NEXUS_BRIDGE_URL
```

```bash
# 環境変数で指定
NEXUS_BRIDGE_URL=http://127.0.0.1:4000/mcp nexus http-bridge

# CLI 引数で指定（最優先）
nexus http-bridge --url http://127.0.0.1:4000/mcp
```

### OpenCode 設定例

```json
{
  "mcpServers": {
    "nexus": {
      "command": "nexus",
      "args": ["http-bridge"]
    }
  }
}
```

> **注意**: 引数なしの Bridge は必要に応じて Nexus HTTP サーバーを自動起動・停止します。Bridge の診断メッセージはすべて stderr に出力されるため、stdout は MCP クライアントとのプロトコル通信に専有されます。
