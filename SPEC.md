# Nexus: Local Codebase Index MCP Server 仕様書

本ドキュメントは、Nexus (Local Codebase Index MCP Server) のアーキテクチャ、コンポーネント構成、および主要な設計仕様をまとめたものです。

## 1. プロジェクト概要

Nexus は、ローカル環境で完結する高度なコードベースインデックスサーバーであり、複数の AI エージェントから Model Context Protocol (MCP) を通じてクロスファンクショナルにアクセスできるように設計されています。

**基本原則:**

- **Zero External Data Transmission**: すべてのインデックスデータはローカル (`<projectRoot>/.nexus/`) に保存され、外部へのデータ送信は行われません。デフォルトの Embedding もローカルのエンドポイント (Ollama 等) を使用します。
- **Event-Driven Pipeline**: ファイルシステムの変更を常時監視し、バックグラウンドで非同期にインデックスを更新するパイプラインアーキテクチャを採用しています。

## 2. アーキテクチャ構成

単一プロセス内に、MCP サーバー (トランスポート層・ツールハンドラ) とバックグラウンドのインデックスパイプラインが共存し、非同期イベントキューで疎結合に連携します。

```text
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Server Process                       │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │  Transport   │───>│        Tool Handlers                 │   │
│  │  (SSE/HTTP)  │    │  hybrid_search / semantic_search /   │   │
│  └──────────────┘    │  grep_search / get_context /         │   │
│                      │  index_status / reindex              │   │
│                      └────────────┬─────────────────────────┘   │
│                                   │                             │
│                      ┌────────────v────────────┐                │
│                      │   Search Orchestrator   │                │
│                      │   (RRF Fusion Engine)   │                │
│                      └──┬─────────────────┬────┘                │
│                         │                 │                     │
│              ┌──────────v──┐    ┌─────────v───────┐             │
│              │  Semantic   │    │  Grep Search    │             │
│              │  Search     │    │  (ripgrep)      │             │
│              │  (LanceDB)  │    │                 │             │
│              └──────────────┘    └─────────────────┘             │
│                                                                 │
│  ┌──────────────────────── Index Pipeline ────────────────────┐ │
│  │                                                            │ │
│  │  [FS Watcher] --> [Event Queue] --> [Diff Detector]        │ │
│  │  (chokidar)       (async queue)     (Merkle Tree)          │ │
│  │                                          │                 │ │
│  │                   [Vector Store] <-- [Embedder] <-- [Chunker]│
│  │                    (LanceDB)      (Plugin)     (Custom/AST)  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### ツール登録レイヤーと依存方向 (Tool Registration Layer)

- ツール定義は SDK 非依存の中立 DSL
  (`src/server/tools/registry/schemas-neutral.ts`) で保持され、
  v1 アダプタ (zod v3) / v2 アダプタ (zod v4) へ変換されます。
  サポート型は string / integer / number / boolean / string[] /
  enum の6種です。
- v2 経路のみアダプタ層で入力上限を適用します
  (`topK <= 100`, `maxResults <= 1000`)。
  v1 経路の既存入力契約は変更しません。
- 依存方向は Transport → Registry Adapters → Tool Handlers /
  Search Orchestrator → Storage Interfaces → Storage Adapters
  の一方向です。Transport 層から Storage Adapter への直接 import、
  および指定モジュール外での SDK v2 直接利用は禁止します。
- SQLite / LanceDB / Watcher / Embedding Provider
  はプロセス起動時に一度だけ生成され、
  MCP 接続単位では生成されません。

### Local HTTP v2 (`nexus serve`)

- MCP プロトコル `2026-07-28` 準拠です。
  SDK v2 のステートレスハンドラを用い、
  `Mcp-Session-Id` とセッション Map は廃止されています。
- bind は loopback (`127.0.0.1` / `localhost` / `::1`) のみ許可し、
  非 loopback host 指定は起動時 fail-closed となります。ホスト名を指定した場合は
  DNS の全解決アドレスが loopback であることを確認します。
- Origin / Host 検証は DNS Rebinding 対策として
  アプリ側ミドルウェアで実施します (SDK は検証を行いません)。
- local-only 契約: 外部 Embedding Provider
  (`openai-compat` / `bedrock`) を設定時に拒否し、
  Ollama の baseUrl も loopback のみ許容します。
- `/health` と `/ready` を提供します。`/ready` はストア初期化状態を返し、
  未準備時は 503 と `NEXUS_STORAGE_UNAVAILABLE` を返します。
- エラーは3層で表現されます。HTTP 層 (403/400/404/413/503)、
  ツール実行層 (`isError: true` と `structuredContent.code` への
  NEXUS_* コード付与、一覧は `src/server/errors.ts`)、
  内部ログ (`console.error` のみ。スタックトレースは
  レスポンスに含めません)。

### stdio-only クライアント向け HTTP Bridge

stdio 接続のみに対応した MCP クライアント（OpenCode など）から、Nexus HTTP サーバーに接続するには、`nexus http-bridge` サブコマンドを使います。Bridge は独立したローカルプロセスとして起動し、標準入出力の JSON-RPC を Nexus の Streamable HTTP エンドポイントに転送します。同一プロジェクトに対しては常に 1 つの Nexus HTTP サーバーを共有し、最後の MCP クライアントが切断すると自動的に停止します。

```text
┌──────────────────┐   stdio   ┌──────────────────┐   HTTP    ┌──────────────────┐
│    MCP Client    │  ──────>  │     nexus        │  ──────>  │     nexus        │
│  (OpenCode etc.) │           │   http-bridge    │           │   --managed      │
└──────────────────┘           └──────────────────┘           └──────────────────┘
```

Bridge はデフォルトで自動的にプロジェクト専用のループバック HTTP サーバーを発見または起動します。既存の HTTP サーバーが `endpoint.json` 記述子で健全性を示していればそれを再利用し、なければ `nexus --port 0 --managed` を detached な子プロセスとして起動します。auto-discovery と auto-launch の descriptor 検証は loopback 専用です。明示 URL モード（`--url` 引数または `NEXUS_BRIDGE_URL` 環境変数）はこの制限の例外で、外部サービスへ接続できます。このモードでは自動起動と descriptor 検証を行いません。

自動管理プロセスの descriptor は `<storage.rootDir>/endpoint.json` に一時ファイルへの書き込み後 `rename` する原子的操作で永続化され、`instanceId`（起動ごとのランダム UUID）、`pid`、`projectRoot`、`url` を含みます。managed server の descriptor 検証と health 検証は loopback 専用で、コネクターは、descriptor の `projectRoot` が要求元と一致し、`url` が `127.0.0.1`（ループバック）を指し、記録された `pid` が生存し、`GET /health` が同一 `instanceId`/`projectRoot` を返す、という条件をすべて満たした場合のみ健全と判定します。いずれかを満たさない descriptor は削除され、再起動候補として扱われます。起動が競合した場合、`project-start-<hash>` ロック（§8.3）を取得できなかった側は新規プロセスを起動せず、既存の健全なプロセスを停止・削除することもありません。取得できなかった側は、ロック獲得側が公開する descriptor をポーリングで待ち受け、健全と判定できた時点で同じ URL に接続します。本機能はループバックのみを対象とし、ネットワーク公開・外部ホストからの接続・systemd 等の外部プロセス管理には依存しません。明示 URL モードではこの descriptor/health 検証を行いません。

同一プロジェクトに対して複数の MCP クライアントが同時に接続できます。各クライアントは独立した MCP サーバー/transport インスタンスを持ちますが、SQLite・LanceDB・File Watcher などのランタイムリソースは 1 つの managed HTTP サーバープロセスだけが所有し、全クライアントで共有します。ここでいう「セッション」はクライアント接続と transport のライフサイクルを指し、クライアントごとにインデックス状態を複製するサーバー側アプリケーション状態を意味しません。これは `nexus http-bridge` の managed HTTP 経路の契約です。直接起動する `nexus serve` は各 HTTP リクエストを独立に処理する stateless v2 経路で、MCP セッションをサーバー側に保持しません。

managed HTTP サーバーは、アクティブなセッション数が 0 になった時点で runtime を閉じ、`endpoint.json` とプロセスロックの両方を削除して終了します（`--idle-shutdown-ms` / `NEXUS_IDLE_SHUTDOWN_MS` で遅延を調整可能、デフォルト `0`）。起動後 30 秒以内に 1 つもクライアントが接続しなかった場合も、同様に自動終了します（起動 grace period）。コネクター自身も、descriptor が既定のタイムアウト（30 秒）以内に健全な状態で公開されない場合（子プロセスが早期に終了しなかった通常のタイムアウトパス）は、原因を標準エラー出力に書き込んで異常終了します。

Bridge および managed HTTP サーバーは、標準出力を MCP の JSON-RPC 専用として扱い、診断メッセージは常に標準エラー出力に書き込みます。

## 3. インデックスパイプライン

### 3.1. FS Watcher と Event Queue

- **常時稼働の Watcher**: OS レベルのファイル監視 (`chokidar`) は停止せず、変更イベントを取りこぼしません。
- **Event Queue と Backpressure**: 変更イベントはキューでバッファリングされ、デバウンス (100ms) されます。キューサイズが閾値 (`fullScanThreshold`: 5,000) を超えた場合はオーバーフロー状態となり、新規イベントを破棄した上でフルスキャン (Reconciliation) へフォールバックし、デススパイラルを防ぎます。
- **起動時 Full Index の post-scan queue**: 未インデックスの通常サービス起動では、
  Watcher 開始前に post-scan モードへ入ります。
  Full Index 中の Watcher イベントは専用キューへ退避します。
  通常の overflow-drop は適用せず、`maxQueueSize` で容量を制限します。
  容量超過分は drain 後に通常の overflow recovery へ引き継がれます。
  `markFullScanComplete()` は post-scan queue を消去しません。
  Runtime 継続時にのみ drain します。

### 3.2. Diff Detector (Merkle Tree)

- **差分検出**: `xxhash` を用いた Merkle Tree により、ファイルシステムの変更 (`added`, `modified`, `deleted`) を高速に検出します。
- **リネーム最適化**: 同一ハッシュの削除と追加が検知された場合、Embedding の再計算をスキップし、データベース上のパスのみを更新 (Rename) して GPU コストを削減します。
- **削除処理**: 削除イベントでは Vector Store 上の該当チャンクと Merkle Tree のノード状態を削除し、存在しないファイルに対する不要な Embedding 再計算を行いません。
- **ディレクトリハッシュ整合性**: add / modify / delete / move の各イベント後に親ディレクトリの Merkle hash を更新し、未変更コンテンツでは root hash が安定し、内容変更時のみ変化する状態を維持します。

### 3.3. Chunker (Custom/AST Parser)

- AST ベースの構文解析により、関数やクラスなどの意味的な単位でコードをチャンク分割します。
- **Failsafe**: AST パースに失敗した場合は、固定行のオーバーラップ分割 (Sliding Window) にフォールバックし、インデックス落ちを防ぎます。
- **Event Loop Protection**: 巨大なファイルのパース時は一定ノードごとにイベントループに処理を譲る (cooperative yielding) ことで、サーバーの応答性を維持します。

### 3.4. Embedder

- `Ollama` や `openai-compat` プラグインを利用し、抽出されたチャンクをベクトル化します。`bedrock` プラグインで AWS Bedrock Runtime を直接呼び出すこともできます（詳細は §10.1）。
- **Concurrency Control**: パイプラインの並行度とは独立して、プロバイダーレベルのセマフォ (`p-limit`) で同時リクエスト数を制限し、GPU VRAM の枯渇やタイムアウトを防ぎます。

- **CPU 負荷抑制 (Ollama Thread Limit)**: Ollama プロバイダーは `/api/embed` リクエストに `options.num_thread` を含めます。デフォルト値は `2` であり、環境変数 `NEXUS_OLLAMA_NUM_THREAD` または `.nexus.json` の `embedding.ollamaNumThread` で変更できます。受付可能な範囲は整数 `1` から `16` までで、無効な値（`0`、負数、小数、`16` 超過など）は安全なデフォルト `2` にフォールバックします。OpenAI-compatible プロバイダーにはこの Ollama 専用オプションは送信されません。
- **共有ロック待機上限**: Ollama の共有グローバルロックは、`retryMode: 'unlimited'` によりリトライ回数を無制限にしますが、`AcquireGlobalLockOptions.timeoutMs` による総待機時間の上限を超えて待機しません。既定の上限は `300000` ミリ秒（5 分）で、環境変数 `NEXUS_OLLAMA_LOCK_TIMEOUT_MS` または `.nexus.json` の `embedding.ollamaLockTimeoutMs` で変更できます。`timeoutMs` は各リトライの待機時間ではなくロック取得全体の上限であり、超過時は `GlobalLockTimeoutError` を通じて Full Index を失敗として記録します。
- **Cache-Aware Embedding Path**: 同一チャンクの再計算を避けるため、L1（インメモリ `Map`）キャッシュと L2（SQLite `embedding_cache` テーブル）キャッシュの二層構造を持ちます。
  - L1 ヒット: `processEventWindow()` 内で `getL1Cache()` 経由にて即座に解決され、`embeddingProvider.embed()` は呼ばれません。キャッシュヒット時は LRU semantics を保つため `delete` & `set` によって Map の insertion order を更新します。
  - L1 ミス & L2 ヒット: `metadataStore.getEmbeddings()` で永続キャッシュを照合し、ヒットしたベクトルを `setL1Cache()` で L1 に hydration します。
  - L2 ミス（True Miss）: `embeddingProvider.embed()` を呼び出し、取得結果を L1 (`setL1Cache`) および L2 (`metadataStore.setEmbeddings`) の両方に書き戻します。L1 は `embeddingCacheSize` で上限が定められており、超過時は最も古いエントリを evict します。
  - **L2 エラーハンドリング**: L2 (SQLite) キャッシュの読み書きに失敗した場合、暗黙的に Embedding の再計算へフォールバックすることはなく、パイプラインの既存エラー動作（DLQ への委譲等）を通じて表出されます。
- **AWS Bedrock Provider**: `bedrock` provider（`src/plugins/embeddings/bedrock.ts`）は `InvokeModelCommand` で Titan v2 埋め込みモデルを直接呼び出します。Titan v2 はバッチ非対応（1 リクエスト = 1 テキスト）のため、`embed(texts[])` は `maxConcurrency` で束ねた N 本の並列 `InvokeModel` 呼び出しにマップします。認証は AWS SDK v3 のデフォルト認証チェーン（環境変数 → SSO → 名前付きプロファイル → IAM ロール）に委譲し、資格情報をコードに保持しません。`region` 未設定時は `us-east-1` にフォールバックし警告ログを出力します。`AccessDeniedException` / `ValidationException` / `ResourceNotFoundException` / `ExpiredTokenException` / `UnrecognizedClientException` は非リトライで即座に失敗させ、`ThrottlingException` や 5xx 相当のエラーは指数バックオフ + full jitter でリトライします（`RetryExhaustedError`）。返却次元が設定次元と異なる場合は `DimensionMismatchError` を即座に投げ、リトライしません。`healthCheck()` はエラー種別ごとに診断メッセージ（認証切れなら `aws sso login`、モデル未有効化なら Bedrock コンソールでのモデルアクセス有効化を促す等）を `console.warn` に出力してから `false` を返します。

### 3.5. 起動時 Full Index と完了状態

- `index_stats` がリインデックスの正常完了状態の唯一の情報源です。行が存在しない、`lastIndexedAt` が `null`、または `lastError` が non-null のときは未完了として扱い、起動時 Full Index の対象にします。`lastIndexedAt` が設定済みで `lastError` が `null` の stale インデックスは自動 Full Index の対象にしません。
- stdio、`nexus serve`、managed HTTP は同じ Runtime 初期化経路を通ります。
  未インデックスなら `run({ fullScan: true, reason: 'startup-reconciliation' })` を
  バックグラウンドで一度だけ開始します。
  `initialize()` はこの Promise を待機せず、手動実行は `reason: 'manual'` を使用します。
- すべてのリインデックスは同じ完了条件を使用します。
  `IndexPipeline` は post-reindex compact を試行し、失敗は非致命として記録します。
  completion lock 下で Vector Store 統計、全永続 DLQ 項目、`index_stats` 更新を
  単一の SQLite transaction として実行します。
- DLQ が空の場合だけ `lastIndexedAt`、`totalFiles`、`totalChunks` を保存します。
  Full reindex は `lastFullScanAt` を更新し、通常 reindex は既存値を保持します。
  `overflowCount` は既存値を保持し、新規行では `0` です。正常完了時は `lastError` を `null` にします。
- リインデックス開始時は保存済み `lastError` を消去します。DLQ が残る、例外が起きる、または停止されたリインデックスは完了日時を保存せず、失敗内容を `lastError` に永続化します。
  DLQ 残存時は成功メトリクスを発火せず、`{ status: 'incomplete' }` を返します。
  `pipelineProgress.lastError` と `skippedFiles` に失敗内容を反映します。
  処理終了後の `pipelineProgress.status` は `idle` に戻ります。
  完了可否は status 単独ではなく `lastIndexedAt` と `lastError` で判定します。
- 自動 Full Index が既存実行と競合した場合は、mutex 解放を待ってから
  post-scan queue を drain します。Runtime 停止時は新規 Watcher イベントを止め、
  post-scan queue を drain せずに破棄します。
  自動 reindex Promise の完了後に Pipeline と stores を閉じます。
- DLQ recovery sweep が単独で項目を処理しても完了日時は記録されません。
  失敗した Full Index からの回復には、DLQ 解消後の再リインデックスが必要です。
- インデックス処理中も検索は待機・拒否・キューイングされません。
- DLQ 残存時の `pipelineProgress.lastError` は安定メッセージ
  `Full reindex incomplete: <count> dead-letter queue item(s) remain`
  です。

### 3.6. 構造化シンボルインデックスパイプライン (Structured Symbol Index Pipeline)

- **デュアルストア設計と正本性**:
  - SQLite (`metadata.db`): 論理シンボルカタログの正本を保持します。ファイル世代ポインタ (`structured_files`)、パース状態・言語・ファイルハッシュを含む世代メタデータ (`symbol_generations`)、シンボル定義・位置・ハッシュ (`symbols`)、インポート宣言 (`imports`)、シンボルとインポートの依存関係 (`symbol_imports`)、および退役シンボル履歴 (`symbol_tombstones`) をトランザクション管理します。ソース本文は DB に一切保存しません。
  - LanceDB (`vectors`): 検索用チャンク、埋め込みベクトル、および `visibility` (`pending` / `active`) フラグを保持します。
  - ワーキングツリー: ソース本文の唯一の正本です。取得要求時に実ファイルを1回だけ `Uint8Array` として読み出し、二段階 SHA-256 ハッシュ検証（ファイルハッシュ照合 + スライスハッシュ照合）を実施して TOCTOU 競合を防止します。
- **世代管理とアトミックコミット (Atomic Generation Protocol)**:
  - ファイル更新時（`stageFile`）は、SQLite に `pending` 世代レコードを作成し、LanceDB に `visibility = 'pending'` でチャンク行を格納します。この中間状態は検索パスから不可視（隔離）されます。
  - 検証成功後、CAS（Compare-And-Swap）による `activateGeneration` を実行して active ポインタをアトミックに切り替え、LanceDB の行を `active` へ昇格し、旧世代行を削除します。中間ステージングで失敗した場合は `clearPendingGeneration` でロールバックし、先行する active 世代を保護します（delete-first 方式の禁止）。
  - 空リコンサイル時のテーブル保護: 構造化対象ファイルが 0 件になった際も、LanceDB のテーブルハンドルを破棄せず `table.delete('true')` で行のみを削除し、後続のステージングでの再作成競合を防止します。
- **フルリビルドと排他制御 (Full Rebuild & Project Locking)**:
  - フルリビルド時はリビルドエポックをインクリメントし、LanceDB のシャドウテーブル（`beginStructuredShadowTable` / `swapStructuredShadowTable`）を利用して、新規世代の準備完了後に原子的スワップとメタデータ一括アクティベーションを実行します。
  - `ProjectWriteCoordinator` により、インクリメンタル更新とフルリビルド間の排他制御を行い、オプションの `lockTimeoutMs` によるタイムアウト制御をサポートします。
- **パイプライン埋め込み整列とパース失敗保護**:
  - Stage 2 におけるチャンク平坦化順序を、ファイル単位（`[...work.chunks, ...(work.structured?.chunks ?? [])]`）で整列し、埋め込みバッチ内のオフセットと `chunkToFilePath` マップを完全に同期させます。
  - 構造化パースに失敗したファイル（`parse-failed`）は、即座に DLQ へ退避し Merkle ツリーを更新しないことで、インデックス不整合を防ぎ次回以降のリカバリを担保します。
- **チャンク行範囲とサブチャンク ID の一貫性 (Oversized Chunk Alignment)**:
  - 宣言が `maxChunkChars` を超えて複数サブチャンクへ分割される場合、分割の開始行は `rawSource` の実際の行スパン（先行する Go コメントや `//go:` ディレクトブを含む）から導出します。最終的な行境界が確定した後、各サブチャンク ID をその同じ境界（`startLine` / `endLine`）から生成し直すことで、行範囲と ID を整合させます（src/indexer/chunker.ts）。
  - パース失敗保護と合わせ、レガシー検索と構造化検索の結果整合を保ちます。

## 4. ストレージ層 (Dual-Store)

### 4.1. Metadata Store (SQLite)

- Merkle Tree の状態とインデックス統計情報を管理します。
- 同時読み書きを可能にする WAL モードを有効化。
- ブロッキングを防ぐため、バルク操作 (INSERT/DELETE) はバッチトランザクションで分割実行され、定期的にイベントループを yield します。

### 4.2. Vector Store (LanceDB)

- チャンクのテキストデータと Embedding ベクトルを保存し、ANN (Approximate Nearest Neighbor) / Exact KNN 検索を提供します。
- **インジェクション対策**: フィルタ値には厳密なホワイトリスト検証 (`validateFilterValue`) と、SQLインジェクション対策のエスケープ (`escapeFilterValue`, `escapeLikeValue`) を行います。
- **In-flight I/O トラッキング**: サーバー終了時 (`close()` 呼び出し時) に実行中の I/O 操作の完了を待機し、安全にリソースを解放します。

### 4.3. Content Store

- `IContentStoreFactory` は `(workspaceId, revisionId)` に束縛された
  `IContentStore` を返します。
  複数の workspace や revision に同じパスがあっても、
  `readRange(path, startLine, endLine)` を一意に解決できます。
- `put`、`get`、`delete`、`exists` はグローバルに一意な content hash をキーとします。
  `readRange` はスコープされた Metadata Store を通じて path を content hash に解決します。
- `IContentStore` の hash-addressed CRUD は将来の content-addressed backend 契約です。
  現行の `LocalContentStore` は Phase 4 の段階実装であり、`put` / `delete` は未実装、
  `get` / `exists` は常に未格納を返します。実際に提供しているのは
  PathSanitizer の検証後にローカルファイルシステムから必要な範囲を読み出す
  `readRange` だけです。外部ストレージや外部へのソースコード送信は導入しません。
- Phase 4 の content-addressed backend では、hash の共有と認可を分離します。
  `get` / `exists` はグローバルに一意な hash の共有 blob を参照できますが、
  呼出し元の workspace / revision に対する認可確認を先に通過していることが前提です。
  `put` は hash の所有・登録境界で検証し、`delete` は参照中の hash を削除せず、
  参照がなくなった共有 blob だけを GC 対象にします。workspace / revision の path 解決、
  hash の所有権、参照管理は `IContentStore` の単純な hash CRUD だけに委ねず、
  Metadata Store または backend 境界で一貫して実施します。

### 4.4. Compaction (コンパクション)

LanceDB のフラグメンテーションを防ぐため、以下のタイミングで排他制御 (`AsyncMutex`) のもとコンパクション (`optimize`) が実行されます:

1. **Post-reindex**: リインデックス完了後
2. **Idle-time**: パイプラインが一定時間 (5分) アイドル状態になった時

## 5. 検索エンジン

### 5.1. RRF Fusion (Search Orchestrator)

- **Semantic Search**: LanceDB によるベクトル類似度検索。
- **Grep Search**: `ripgrep` の子プロセスを呼び出した高速なテキスト・正規表現検索。タイムアウト付きの `AbortController` でゾンビプロセスを防止。
- **RRF (Reciprocal Rank Fusion)**: Semantic 検索と Grep 検索の結果を統合し、最適なランキング (`topK`) を返します。

## 6. AI エージェント統合と探索パイプライン

Nexus は単体の MCP 実行基盤として動作するだけでなく、プロジェクトローカルのエージェント指示書（`AGENTS.md`）およびスキルファイル（`.agents/skills/*.md`）と連携して、AI エージェントがツール選択に迷わず効率的にコード探索できるように設計されています。

### 6.1. 3 層分離アーキテクチャ

```text
[ AI Agent ]
    │
    ├─ 1. Global Layer: AGENTS.md            ← 常駐、トリガー判定のみ（50行以内）
    ├─ 2. Procedure Layer: .agents/skills/  ← 動的ロード、タスク別最適パイプライン
    └─ 3. Execution Layer: Nexus MCP        ← 実行・検索・構造追跡（.codegraph/ 使用可）
```

| レイヤー | コンポーネント | 役割 |
| --- | --- | --- |
| グローバル層 | `AGENTS.md` | プロジェクト基本制約と、タスク種別ごとのツール・スキル選択トリガーを決定論的に記述 |
| 知識・手順層 | `.agents/skills/*.md` | タスクごとの実行フロー標準化。Nexus と CodeGraph の役割分担、One-Call、Deferred Loading 手順を記述 |
| 実行・接続層 | `Nexus MCP` + 任意の CodeGraph | コード検索・ベクトルアクセス・ファイルコンテキスト取得。CodeGraph は `.codegraph/` が存在する場合のみ活用 |

手順層はエージェントが従う操作契約であり、Nexus MCP は各ツールを任意順序で受け付けます。ロードは利用するエージェントホストの Skill ローダーが担い、MCP サーバーは手順の順序を強制しません。

### 6.2. 標準探索パイプライン

`.agents/skills/code-search.md` は、以下の標準パイプラインを定義します。

```text
Step 1: タスク分類
  → 抽象/概念調査？ 正確なシンボル追跡？ エラー原因特定？ 構造追跡？

Step 2: 存在するインデックスを使い分ける
  → .codegraph/ がある場合：codegraph_explore で構造・Call Tree を特定（Nexus の index_status は不要）
  → 曖昧な検索：Nexus index_status を確認してから hybrid_search
  → 正確なシンボル/エラー文字列：Nexus index_status を確認してから grep_search
Step 3: ファイルコンテキスト取得
  → Nexus get_context(startLine, endLine) で最小範囲を取得
  → ファイル全体が必要な場合のみ全体取得

Step 4: 修正・回答へ移行
```

### 6.3. One-Call 行動パターン

`hybrid_search` や `grep_search` のトップ候補に対して、結果を返す前に `get_context` を呼び出し、行番号範囲を絞ってまとめて返します。検索とコンテキスト取得を別々の往復に分けないことで、ツール呼び出し往復数を削減します。

本フェーズの One-Call は、エージェントが複数の MCP ツール呼び出しを完了して一度の根拠付き回答を返す行動パターンを指します。`hybrid_search` は `includeSnippet: true` を指定することで、単一のツール呼び出しで検索結果とコードスニペットを同時に返すことも可能です（詳細は §6.6 を参照）。

### 6.4. Deferred Loading

大きなファイルや大量の検索結果を扱う場合は「概要 + 行番号 + 必要に応じた取得コマンド」を優先し、全文を一括展開しません。追加コンテキストは、初回のスニペットで不足する場合またはユーザーが詳細を求めた場合だけ取得します。

### 6.5. CodeGraph 連携

リポジトリに `.codegraph/` ディレクトリが存在する場合、構造・依存関係・コールツリーの追跡には `codegraph_explore` を優先します。存在しない場合は Nexus 単体（`hybrid_search` / `grep_search` + `get_context`）でカバーします。

### 6.6. 実装された機能（スニペット添付 / Deferred Loading）

探索パイプラインの効率化のため、`hybrid_search` と `get_context` に以下の機能が実装されています。いずれもオプトイン（デフォルト無効）であり、既存の呼び出し方との後方互換性を維持します。

- **`hybrid_search` のスニペット付き応答**（[`src/server/tools/hybrid-search.ts`](src/server/tools/hybrid-search.ts)）: `includeSnippet: true` を指定すると、各結果の `chunk.startLine`/`endLine` を中心に前後 `contextLines` 行（デフォルト 3、20 を超える値は 20 にクランプ）を含むコードスニペットを取得し、`snippet` / `snippetStartLine` / `snippetEndLine` を結果へ追加します。これにより One-Call パターンにおいて、上位候補向けの追加 `get_context` 呼び出しを削減または省略できます。
- **`get_context` の Deferred Loading モード**（[`src/server/tools/get-context.ts`](src/server/tools/get-context.ts)）: `mode: "deferred"` を指定すると、全文の代わりに `totalLines` / `summary`（プレビュー。`startLine` と `endLine` を両方明示指定した場合はその範囲を file bounds にクランプしたもの、それ以外はデフォルトで最大 20 行）/ `previewStartLine` / `previewEndLine` / `hint` を含む要約レスポンスを返し、全文展開をユーザーまたは下位ツールの要求に委ねます。
- 両機能に共通する行範囲解決ロジック（`resolveLineRange` / `sliceContent`）は [`src/server/tools/context-helpers.ts`](src/server/tools/context-helpers.ts) に切り出され、`hybrid_search` と `get_context` の双方から利用されています。
- `includeSnippet` / `contextLines` / `mode` はすべて任意入力です。`includeSnippet` 未指定または `false` の場合、スニペットフィールドは追加されません。`contextLines` は正の整数だけを受け付け、20を超える値は20にクランプされます。
- スニペットのサニタイズまたはファイル読込に失敗した場合は、その結果の `chunk` / `score` / `source` / `rank` / `reciprocalRankScore` を維持したまま、スニペットフィールドだけを省略します。検索全体は失敗しません。
- `get_context` の `mode` 未指定時は eager レスポンス（`filePath` / `content` / `startLine` / `endLine`）を維持します。deferred レスポンスには `content` / `startLine` / `endLine` を含めません。
- 取得行数は既存の `nexus_context_lines_fetched_total` で計上します。`hybrid_search` は呼び出しごとに、読込成功したスニペット範囲を結果間で重複排除した行数を1回計上し、deferred はプレビュー範囲の行数を計上します。
- **検索層との分離**: スニペット付与は `SearchOrchestrator` による検索の完了後（上位候補選出後）にツール層で行われます。表示専用の引数（`includeSnippet`, `contextLines`）は検索層の `SemanticSearchParams` には流出しません。
- **パフォーマンスと安全性の保護**: 同一ツール呼び出し内で複数の検索結果が同じファイルを参照する場合、サニタイズとファイル読込はインメモリでキャッシュ（`Map<string, string | null>`）され、I/O 増幅を防ぎます。また、クライアントからのリクエストが中断（Abort）された場合、以降のスニペットファイル読込は開始されません。進行中の `loadFileContent` 読込はキャンセルされず、完了後に Abort を再確認します。

各 MCP ツールの JSON Schema `description` は、ツール選択を支援する簡潔な説明へ
最適化済みです。各ツールの JSON Schema は MCP プロトコル統合テストで、inputSchema の存在と `properties` キー集合を固定検証します。

探索パイプラインの適用が正しいことを確認するための具体例は、`.agents/skills/code-search.md` の「Verification examples」セクションに記載しています。曖昧な機能探索、正確なシンボル追跡、構造・コールツリー探索の 3 シナリオについて、ユーザー入力・期待ツール列・成功基準を定義しています。

## 7. MCP ツール


AI エージェントに公開される MCP ツールとそれぞれの設計役割・ユースケースは以下の通りです:

- **`hybrid_search`**
  - **役割**: セマンティック（ベクトル）検索と ripgrep によるテキスト検索をハイブリッドに行い、RRF (Reciprocal Rank Fusion) で統合した最適ランキング (`topK`) を返します。
  - **ユースケース**: 概念的な探索や、曖昧な要件に関連するコード箇所を見つける場合に最も推奨されます。
- **`semantic_search`**
  - **役割**: LanceDB に対する純粋なベクトル類似度検索です。
  - **ユースケース**: 「これと似たような処理を行っている関数」など、文字列の一致に依らない類似構造・セマンティクスに基づく探索に適しています。
- **`grep_search`**
  - **役割**: ripgrep 子プロセスを使用した、高速かつ厳密なキーワード・正規表現検索です。
  - **ユースケース**: 特定のクラス名、関数定義、エラーメッセージ、定数など、一致する文字列を正確に特定したい場合に有効です。
- **`get_file_outline`**
  - **役割**: 既知の対応ファイルから、アクティブなシンボル・アウトラインをソーステキストなしで返します。
  - **ユースケース**: ファイルにどのようなシンボルがあるか把握し、次に `get_symbol_source` / `get_symbol_context` で取得する ID を選びたい場合に使用します。
- **`get_symbol_source`**
  - **役割**: 構造化シンボル ID (`symbol_v1_<base64url-sha256>`) から、インデックス時に記録された正確なソースを返します。
  - **ユースケース**: `semantic_search` / `hybrid_search` / `get_file_outline` で得た `symbolId` を使い、行番号推測なしで完全な宣言を取得します。
- **`get_symbol_context`**
  - **役割**: `get_symbol_source` と同じソースに加え、検証済みの関連 import を取得し、指定したトークン予算内で関連 import を選択してシンボルソースと結合したコンテキストを返します。
  - **ユースケース**: シンボルの実装とその依存関係を一度の呼び出しで取得したい場合に使用します。トークン予算を超えてもシンボルソースは完全に返されます。
- **`get_context`**
  - **役割**: 指定されたファイルから、必要な行範囲（`startLine` 〜 `endLine`）を切り出してコンテキストとして取得します。
  - **引数**: `startLine` および `endLine` はオプションです。これらが指定されない場合、ファイル全体のコンテンツを取得します。
  - **ユースケース**: 検索で見つかったファイルの詳細を把握するために使用します。LLMのコンテキストウィンドウを無駄に消費しないよう、極力取得範囲を絞り込んで使用する設計となっています。
- **`index_status`**
  - **役割**: インデックス構築の進捗状況、登録ファイル数、DLQの未処理/失敗イベント数などの統計情報を返します。
  - **ユースケース**: 検索を実行する前に、インデックスが構築中（`pipelineProgress.status === 'running'`）か完了しているかをエージェント自身が確認するために使用されます。
- **`reindex`**
  - **役割**: 既存のインデックスデータを一旦クリアまたは整合性検証し、最初からファイルをスキャンし直してインデックスを再作成します。
  - **ユースケース**: 大規模なファイル更新やブランチ切り替えによってインデックスが不整合を起こした際、手動でリフレッシュするために使用します。

**Path Sanitization (セキュリティ)**:
すべてのツールハンドラで入力パスに対する2段階検証 (論理パス・物理パスの検証および symlink 解決) を行い、プロジェクト外へのパストラバーサル攻撃を防御します。

**構造化 symbol 検索の契約**:

- 構造化検索を有効にするには、`reindex({ fullRebuild: true })` で明示的にフルリビルドする必要があります。レガシーインデックスは自動移行されず、構造化ツールは `reindex_required` / `not_indexed` ステータスでゲートされます。
- `semantic_search` / `hybrid_search` の結果に `chunk.symbolId` が含まれる場合、優先して `get_symbol_source` または `get_symbol_context` を使用します。`get_file_outline` は既知の対応ファイルのシンボルマップを返します。
- grep ヒット、行指向リクエスト、インデックス対象外・未対応ファイル、パーサーが確定できない宣言については、従来どおり `get_context` を使用します。
- **決定論的 ID 体系**:
  - `symbolId`: `symbol_v1_<base64url-sha256>`。`[1, filePath, qualifiedName, kind, signatureDiscriminator, occurrence]` の正準 JSON 配列から生成されます。コード本体の変更や行移動では維持され、シグネチャ変更やリネームで新 ID となります。
  - `generationId`: `[schemaVersion, parserId, parserVersion, fileContentHash]` の SHA-256 base64url。
- **言語パーサーと Exactness 境界**:
  - TypeScript/JavaScript: TS Compiler API を使用。JSDoc、デコレータ、修飾子を含む AST 境界。単一識別子の宣言のみ exact。
  - Python: `tree-sitter-python` を使用。トップレベル class / function、class method。デコレータを含む。
  - Go: `tree-sitter-go` を使用。型宣言、関数、レシーバーメソッド、インターフェースメソッド仕様。直前の空行なしコメントおよび `//go:` コンパイラディレクティブを含む。レシーバーまたは所有インターフェース名で修飾（`Reader.Read`）。
- **トークン会計とコンテキスト生成**:
  - `js-tiktoken` の `cl100k_base` を使用して再現可能にトークン数を計測します。
  - コンテキスト形式: `[importText]\n\n[symbolSource]`。
  - `get_symbol_context` は `tokenBudget` 内に収まるよう関連 import を追加し、予算超過時でもシンボルソースは完全に返します。超過分は `budget.exceeded: true` と `omittedForBudget` カウントで報告します。
- **Fail-Closed 鮮度検証とステータス体系**:
  - 構造化ツールはファイルの現在のバイトハッシュをインデックス時のハッシュと比較し、不一致時は source-free な `stale` / `INDEX_FILE_HASH_MISMATCH` で fail-closed します。
  - ファイルが削除されている場合は `INDEX_FILE_MISSING`、未対応言語の場合は `unsupported_language`、対象外パスの場合は `PATH_EXCLUDED`、スキーマ不一致時は `STRUCTURED_SCHEMA_UNSUPPORTED`、解析に失敗または不完全な場合は `PARSER_COVERAGE_PARTIAL` / `INDEX_SYMBOL_HASH_MISMATCH` / `INDEX_IMPORT_HASH_MISMATCH` を返します。退役した ID に対しては `stale_identity` / `SYMBOL_RETIRED` を返します。同じ名前のシンボルは異なる `symbolId` で区別されます。
  - 正常時（`status: 'ok'`）は、常に `freshness: 'fresh'` および `reindexRequired: false` を保証します。

## 8. 耐障害性とエッジケース (Resilience)

### 8.1. Dead Letter Queue (DLQ)

- Embedding のリトライが上限に達したイベントは DLQ に退避され、インデックスパイプラインの停止を防ぎます。
- バックグラウンドのリカバリループが定期的にヘルスチェックを行い、プロバイダー復旧後に再処理 (Reprocess) を試みます。DLQ内のリカバリスイープ処理は排他制御されており、二重起動は防止されます。
- **リカバリ試行制限**: リカバリ試行回数の上限（`maxRecoveryAttempts`、デフォルト5回）に達したエントリは、無限ループ防止のためキューから自動的に破棄（abandoned）され、手動でのリインデックスを促す警告を出力します。
- **TTLパージ**: リカバリスイープの実行開始時に、作成から一定時間（`ttlMs`、デフォルト24時間）が経過した期限切れエントリを自動的にクリーンアップします。
- 古くなった (stale) イベント (キューイング後にファイルが更に変更された等) は、ハッシュ比較により自動的に破棄されます。

### 8.2. Startup Reconciliation

- サーバー起動時に SQLite の Merkle ハッシュと実際のファイルシステムのハッシュを突き合わせます。
- クラッシュ等によって生じた LanceDB と SQLite 間のデータ不整合 (Orphan, Missing, Stale) を検出し、自動的に修復・再インデックスを行います。
- これにより、複雑な Write-Ahead Log (WAL) なしに結果整合性を保証します。

### 8.3. Process Locking (プロセス間排他制御)

#### Project-Level Lock (プロジェクト単位ロック)

- CLI 起動時は `storage.rootDir` 直下の `nexus.pid` を用いた単一プロセス検出を行います。既存 PID が生存していれば起動を中止し、停止済みプロセスの stale PID は再起動時に回収します。
- runtime 作成時（`NexusServerFactory.createRuntime()`）は、同一プロジェクトへの複数プロセス起動によるデータベース・File Watcher の競合を防ぐため、`proper-lockfile` による `<projectRoot>/.nexus-lock` の project-level lock も別途取得します。取得に失敗した場合は即座に起動を中止します。`proper-lockfile` はクラッシュ時の stale lock をこのロックについて自動検出・解除します。
- 自動管理される HTTP サーバーの起動時は、さらに `project-start-<hash>` という名前のグローバル起動ロックを使用し、同じプロジェクトに対して複数の Bridge から同時に子プロセスが起動するのを防ぎます。このロックの取得に失敗した側は新規プロセスを起動せず、既存の健全なプロセスを停止・削除することもなく、取得側が公開する descriptor をポーリングして待ち受けます（失敗にはなりません）。

#### Global Ollama Lock (Ollama グローバルロック)

- 同一マシン上で複数の Nexus プロセスが Ollama に同時にアクセスし、CPU を奪い合うのを防止します。
- `/tmp/nexus-global-ollama.lock` をシステム全体で共有し、`embed` の実行をプロセス間で直列化します。
- 同一プロセス内の並列度（`p-limit`）は維持され、インタープロセス間のみ排他制御が働きます。
- **Unlimited Queuing & Stale Policy**: グローバルロックは `proper-lockfile` のファイルベースロックを使用します。`acquireGlobalLock` は `AcquireGlobalLockOptions`（`retries`, `minTimeoutMs`, `maxTimeoutMs`, `retryMode`, `signal`, `timeoutMs`）を受け取り、デフォルトでは有限リトライ（10回、最大1000ms間隔）を行いますが、Ollama 埋め込み（`OllamaEmbeddingProvider.embed`）では `retryMode: 'unlimited'`、`maxTimeoutMs: 5_000`、`timeoutMs: ollamaLockTimeoutMs`、および `AbortSignal` を指定します。`retryMode: 'unlimited'` は `ELOCKED` に対するリトライ回数の上限を外しますが、`timeoutMs` が指定されている場合はロック取得全体の待機時間がその上限で制限されます。リトライ間隔は残り時間を超えないよう調整され、上限到達時は `GlobalLockTimeoutError` になります。したがって、並行インデックスや複数 Nexus プロセスからの Ollama リクエストは、リトライ回数の上限による `GlobalLockHeldError` ではなく、設定した待機上限または `AbortSignal` により終了します。待機中は `ELOCKED` エラーのみをアプリ層で再試行し、`AbortSignal` を常時監視してキャンセル時は即座に中断します。また、ロック保持プロセスがクラッシュした場合は `proper-lockfile` の `stale: 60_000ms` 機構により自動回復します。
- **Error Safety**: `embed()` 呼び出しは `try { ... } finally { lock.release() }` で囲まれており、成功・失敗・例外・キャンセルのいずれでも確実にロック解放が試行されます。ロック取得直後にキャンセルが検知された場合も、ロックを解放してからキャンセル理由を伝播します。`AbortSignal` に abort reason が設定されていれば `signal.reason` を、設定されていなければ `AbortError` を使用します。解放失敗は元のエラーを隠蔽しません。
- **Coarse Lock Scope**: ロック範囲は `embed()` 全体（全バッチ）であり、バッチ単位には分割しません。Ollama は単一ローカルモデルを直列実行するため、バッチごとのロック取得・解放（lock thrashing）より、`embed()` 全体で排他する方が Ollama のローカルモデルキューを効率化できます。ロック粒度をバッチ単位に下げることや、Ollama 専用の共有プロセスキューの導入は非目標（Non-Goals）です。

### 8.4. CI セキュリティ監査の耐障害性 (CI Network Resilience)

- CI ワークフローにおける `npm audit` 実行時、一時的なネットワーク障害（HTTP 502, 503, 504 や fetch エラー）に対して指数バックオフ付きリトライ（最大3回）を実行し、外部レジストリの通信瞬断による CI 偽陽性失敗を防止します。

## 9. Observability (可視化)

Nexus は、単一プロセスの内部状態だけでなく、複数プロジェクト・複数 Nexus プロセスを横断したアプリケーション層メトリクスを Prometheus / Grafana で監視できるように設計されています。

### 9.1. Metrics Collector & HTTP Server

- 各コアモジュール (EventQueue, IndexPipeline, DLQ) に `metricsHooks` を注入し、非同期でメトリクスを収集します。
- MCP ツール、検索結果数、コンテキスト取得行数、Embedding provider 呼び出しも同じ `MetricsCollector` に集約されます。
- `prom-client` を使用してインメモリで状態を集計します。メトリクス収集自体はパフォーマンス保護のため I/O を行いません。
- `MetricsCollector` は `project` と `pid` を default label として全メトリクスに付与します。`project` は `projectName`、`NEXUS_PROJECT_NAME`、プロジェクトルートのベース名の順で解決されます。
- メトリクスレジストリが有効な場合、バックグラウンドで HTTP サーバーが起動し、`127.0.0.1` 上で以下のエンドポイントを提供します。`metricsPort` / `NEXUS_METRICS_PORT` が未指定の場合は OS により空きポートが自動割当され、解決済みポートは `storage.rootDir` 配下の `metrics.port` に書き込まれます。
  - `GET /metrics`: Prometheus 形式のメトリクス
  - `GET /metrics/json`: `prom-client` の JSON 配列形式メトリクス
  - `GET /health`: メトリクスサーバーのヘルスチェック

### 9.2. Application-level Metrics

既存の Queue / Indexing / DLQ メトリクスに加え、AI エージェント利用状況と検索品質を把握するために以下のアプリケーション層メトリクスを公開します。

| Metric | Type | Labels | Purpose |
| --- | --- | --- | --- |
| `nexus_tool_calls_total` | Counter | `project`, `pid`, `tool_name`, `status` | MCP ツール呼び出し回数とエラー率 |
| `nexus_tool_duration_seconds` | Histogram | `project`, `pid`, `tool_name` | MCP ツール実行レイテンシ |
| `nexus_search_results_hits` | Histogram | `project`, `pid`, `search_type` | 検索ヒット件数分布 |
| `nexus_context_lines_fetched_total` | Counter | `project`, `pid`, `tool_name` | エージェントが取得したコード行数 |
| `nexus_embedding_requests_total` | Counter | `project`, `pid`, `provider`, `status` | Embedding provider 呼び出し回数 |
| `nexus_embedding_duration_seconds` | Histogram | `project`, `pid`, `provider` | Embedding provider レイテンシ |
| `nexus_embedding_batch_size` | Histogram | `project`, `pid`, `provider` | Embedding request の batch size 分布 |
| `nexus_structured_retrieval_outcomes_total` | Counter | `project`, `pid`, `tool`, `status` | 構造化取得ツール (`get_symbol_source` / `get_symbol_context` / `get_file_outline`) のステータス別結果回数 |
| `nexus_structured_parser_outcomes_total` | Counter | `project`, `pid`, `language`, `parse_status` | 言語別・パースステータス別の構造化パーサー結果回数 |
| `nexus_structured_context_tokens` | Histogram | `project`, `pid`, `tool`, `measurement` | 構造化コンテキストのトークン数 (`requested` / `actual`) |
| `nexus_structured_budget_overflows_total` | Counter | `project`, `pid`, `tool` | 予算超過により省略された import 数の累積 |
| `nexus_structured_catalog_files` | Gauge | `project`, `pid`, `coverage` | 構造化カタログのファイル数 (`exact` / `degraded` / `pending`) |
| `nexus_structured_catalog_symbols` | Gauge | `project`, `pid` | 構造化カタログのシンボル総数 |
| `nexus_structured_catalog_coverage_files` | Gauge | `project`, `pid` | 構造化カタログのカバレンジ（exact ファイル数 / 総ファイル数） |

構造化取得メトリクスの `tool` ラベルはツール名のみを含み、**ファイルパス・symbol ID・qualified name をメトリクスラベルやログへ含めることはありません**（検索対象のメタデータがメトリクス経由で外部に漏れることを防止するため）。

MCP ツールは `withToolMetrics` によりハンドラー外側で成否とレイテンシを計測します。検索結果数や `get_context` の取得行数などの固有メトリクスは、ハンドラー内で結果オブジェクトが確定した後に記録します。Embedding provider は Decorator (`InstrumentedEmbeddingProvider`) でラップされ、既存 provider 実装を変更せずに `embed()` の成功・失敗・処理時間・バッチサイズを記録します。

### 9.3. Telemetry Aggregator

`nexus dashboard` は TUI と同じプロセス内で Telemetry Aggregator を起動します。Aggregator は複数 Nexus プロセスを登録・監視し、Grafana / Prometheus 向けの単一 scrape endpoint を提供します。

```text
Nexus Process A (:metricsPort) ─┐
Nexus Process B (:metricsPort) ─┼─ POST /api/discovery/register ─┐
Nexus Process C (:metricsPort) ─┘                                │
                                                                  ▼
                                                   nexus dashboard Aggregator
                                                   GET /metrics -> JSON merge -> Prometheus text
```

Aggregator のエンドポイントは以下の通りです。

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/discovery/register` | Nexus プロセスの登録・Heartbeat。`metricsPort` を key として upsert します。 |
| `GET` | `/metrics` | 全登録ノードの `/metrics/json` を集約し、Prometheus テキスト形式で返します。 |
| `GET` | `/health` | Aggregator 自身のヘルスと登録ノード数を返します。 |
| `GET` | `/api/discovery/nodes` | 登録ノード一覧をデバッグ用に返します。 |

`POST /api/discovery/register` は `projectId`、`metricsPort`、`pid` を必須フィールドとして検証します。不正な登録 payload は `400 Bad Request` として拒否され、該当ノードはスタンドアロンの Nexus プロセスとして稼働を継続します。

`GET /metrics` は登録済みノードを並列に取得し、`Promise.allSettled` の fulfilled 結果だけを採用します。個別ノードの失敗はスキップされ、他ノードの結果は返却されます。全ノード取得に失敗した場合も Prometheus 互換の空テキストを HTTP 200 で返します。メトリクスは名前ごとにグループ化され、`values` は単純結合されます。各 Nexus プロセスが `project` / `pid` default label を付与するため、異なるノードの label set は一意であり、Histogram の `_bucket` / `_sum` / `_count` も算術加算せずそのまま再構築できます。

### 9.4. Registration & Health Checking

通常モード（`packageMode=false`）では、各 Nexus プロセスはメトリクス HTTP サーバー起動後、`RegistrationClient` により Aggregator へ登録されます。

- 起動直後に `POST /api/discovery/register` を送信し、その後 30 秒間隔で Heartbeat を送ります。
- 登録リクエストのタイムアウトは 1 秒です。
- Aggregator 未起動、停止、ネットワーク遅延、タイムアウトは debug ログのみで扱われ、Nexus 本体の稼働を停止させません。
- Aggregator は 15 秒間隔で登録ノードの `/health` を確認し、失敗または非 OK 応答のノードを即座に evict します。誤判定された場合も、次回 Heartbeat により最大 30 秒程度で再登録されます。
- **Package Mode での登録スキップ**: `NEXUS_PACKAGE_MODE=1` で起動した場合、`registrationClient` は生成されず（`null`）、Aggregator への登録・Heartbeat は行われません。ローカルの metrics HTTP サーバーおよび `nexus dashboard`（TUI）はこのモードでも変わらず起動します（§10.1 参照）。

### 9.5. TUI Dashboard, Standalone Aggregator & Grafana

- Dashboard は独立した npm workspace パッケージ (`@yohi/nexus-dashboard`) として実装されています。
- `nexus dashboard` サブコマンドで起動し、React と ink を使用した Queue / Throughput / DLQ Health の TUI を提供します。
- `nexus aggregator` サブコマンドは、TUI画面を立ち上げず、メトリクス集約サーバー（AggregatorServer）のみをバックグラウンド（単体プロセスやデーモン）で起動するために使用します。
- `--port <number>` で接続先メトリクスサーバーのポートを指定できます。指定がない場合は `metrics.port` ファイルから自動検出し、自動検出できない場合はエラー終了します。
- `--aggregator-port <number>` (または `aggregator` コマンドにおける `--port`) で Aggregator の待受ポートを指定できます。解決順序はオプション引数、`.nexus.json` の `aggregatorPort`、`NEXUS_AGGREGATOR_PORT`、`9470` です。
- Aggregator 起動時に `EADDRINUSE` が発生した場合は、既に別プロセスで Aggregator が起動済みとみなし、TUI クライアント（または集約プロセス）として継続、あるいはスキップします。
- Grafana ダッシュボード定義は `docs/observability/grafana-dashboard.json`、セットアップ手順とメトリクスカタログは `docs/observability/README.md` にあります。

## 10. パッケージ版としての配布 (Package Mode & Distribution)

Nexus は単一コードベース上で、開発者向けのオリジナル動作（`packageMode=false`、デフォルト）と、社内向けに統制されたパッケージ版プラグイン（`packageMode=true`）の両方を提供します。フォークやコード複製ではなく、設定駆動で差分を表現します。

### 10.1. Package Mode (`NEXUS_PACKAGE_MODE`)

#### 実装上の注意

`packageMode=true` 時に Aggregator への登録を確実にスキップするため、`src/server/index.ts` で `registrationClient = options.packageMode ? null : createRegistrationClient(...)` としてガードしています（`src/server/factory.ts` から `packageMode` を伝搬）。これにより外部連携（Aggregator 登録）は真に除外されつつ、ローカル metrics/TUI は維持されます。

#### 設定項目

- `Config.packageMode: boolean`（env `NEXUS_PACKAGE_MODE`、既定 `false`）。
- `true` の場合、`src/server/factory.ts` の `assertPackageModeConstraints()` が `setupPluginRegistry()` の最初に呼ばれ、`embedding.provider !== "bedrock"` なら即座に fail-fast で例外を投げます（サーバー起動失敗）。
- **ロック対象は provider のみ**です。`model` / `dimensions` / `region` はデプロイ時に運用者が変更できる可変値であり、ハードロックの対象外です。
- メトリクス層には非干渉です。`MetricsCollector`・各プロセスの metrics HTTP サーバー・`nexus dashboard`（TUI）は `packageMode` の値に関わらず常に起動します。一方、Grafana/Prometheus 向けの Aggregator への自動登録（`RegistrationClient`）のみ `packageMode=true` でスキップされます（§9.4）。

### 10.2. ソースミラー配布 (Bitbucket 経由の Claude Code Plugin)

Nexus は社内 Claude Code plugin marketplace（Bitbucket Cloud 上でホスト）を通じて `yohi-nexus` という名前で配布されます。`better-sqlite3` / `@lancedb/lancedb` のネイティブ依存と `tsc` の非バンドルビルドを持つため、一般的な「`dist/` のみを配布する」方式は使えません（ビルド済み `dist/` は実行時に `node_modules` と、利用者プラットフォーム向けにビルドされたネイティブバイナリを必要とするため）。代わりに「ソースミラー」方式を採用します。

**本節では仕組みと設計意図のみを説明します。実行手順（トークン発行、Secret 登録、ワークフロー実行手順、トラブルシューティング等）は [docs/distribution.md](docs/distribution.md) に集約しています。**

- `.github/workflows/deploy-plugin-to-bitbucket.yml`（`workflow_dispatch` トリガ）が、最新の GitHub Release tag を取得し、`npm ci` → lint → test の品質ゲートを通過後、`scripts/stage-plugin-dist.sh dist-staging` でビルド可能な最小ソース一式（`package.json`, `tsconfig*.json`, `src/`, `packages/dashboard`, `.claude-plugin/plugin.json`, `scripts/setup-plugin.sh`, `LICENSE`, `NOTICE`）を staging し、自己完結ビルド検証（`npm install && npm run build`）と `claude plugin validate --strict` を経て Bitbucket `y-ohi/nexus` へ force-push します（常に 1 コミットのクリーンな状態）。
- `stage-plugin-dist.sh` は staging 時に `.claude-plugin/plugin.json` の `userConfig`（ollama/openai-compat 選択 UI）を除去し、`mcpServers.nexus.env` を固定リテラル（`NEXUS_PACKAGE_MODE=1` / `NEXUS_EMBEDDING_PROVIDER=bedrock` / `NEXUS_EMBEDDING_MODEL` / `NEXUS_EMBEDDING_DIMENSIONS` / `NEXUS_EMBEDDING_REGION` / 任意 `NEXUS_EMBEDDING_PROFILE`）へ置換します。これらの固定値の実際の値（region/model/dimensions）は GitHub Actions 変数でデプロイ運用者が変更できます（個々の変数名と既定値は [docs/distribution.md の P6](docs/distribution.md) を参照）。**ソース側の `.claude-plugin/plugin.json` 自体は編集しません**（変換は stage 時のみ）。
- 利用者マシンでは Setup フックの `scripts/setup-plugin.sh` が `npm install --no-audit --no-fund` → `npm run build` を実行します。AWS Bedrock 呼び出しに必要な AWS 資格情報の用意方法は §3.4（Embedder）の認証チェーン説明と [docs/distribution.md の P5](docs/distribution.md) を参照してください。
- 汎用的な「Bitbucket 上の社内 Claude Code plugin marketplace」構築パターン（marketplace リポジトリ、複数 plugin の配布フロー、認証方式など）自体は Nexus 固有ではなく、`.github/workflows/deploy-plugin-to-bitbucket.yml` と `.github/workflows/update-marketplace-entry.yml` の実装が正の参照先です。ネイティブ依存プラグインが「dist のみ」ルールを適用できずソースミラー方式を採る、という例外規定はこのパターンの一部として定義されています。
- marketplace カタログ更新処理（git clone/commit/push の retry ループ + エントリ upsert）は `scripts/update-marketplace-catalog.sh` と `scripts/marketplace-update-entry.mjs` に共通化され、`deploy-plugin-to-bitbucket.yml`（D1）と `update-marketplace-entry.yml`（D2）の両方から呼び出されます（二重実装を回避）。Bitbucket リポジトリ URLは直接指定しない方式を採用し、Repository variable `BITBUCKET_WORKSPACE_NAME`（plugin配布repoとmarketplace catalog repoで共通）+ `BITBUCKET_PLUGIN_REPOSITORY_NAME` / `BITBUCKET_MARKETPLACE_REPOSITORY_NAME` から `https://bitbucket.org/<workspace>/<repository>.git` の形で自動構築します。`PLUGIN_NAME` / `PLUGIN_DESCRIPTION` も含め、これらの Repository variable は両ワークフローで共通参照（[docs/distribution.md の P3・P7](docs/distribution.md) 参照）され、D2 は入力で上書きできますが省略時は D1 と完全に同じ値になるため、手動実行時の値不一致によるカタログの孤立エントリ事故を防いでいます。これらの値にはハードコードの既定値がなく、Repository variable 未設定の場合は `scripts/update-marketplace-catalog.sh` が fail-fast します。
- marketplace エントリの `source` には `ref`（Git tag/branch）を付与してバージョンを pin できます。`deploy-plugin-to-bitbucket.yml` は常に最新の GitHub Release tag を `ref` として自動設定し、`update-marketplace-entry.yml`（手動更新用）は任意の `plugin_ref` 入力で pin 先を指定できます（省略時は unpinned）。
