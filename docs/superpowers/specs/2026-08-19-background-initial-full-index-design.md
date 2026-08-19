# 起動時バックグラウンド Full Index 設計

## 目的

未インデックスのプロジェクトで Nexus を通常サービスとして起動したとき、
サーバーを利用可能にしたままバックグラウンドで Full Index を一度開始する。

対象となる通常サービス経路は、引数なしの stdio、`nexus serve`、および
`http-bridge` が利用する managed HTTP サーバーである。公開ライブラリ API を
直接組み込む利用は対象外とする。

## 制約と決定

- 未インデックスとは、正常完了した reindex が一度も記録されていない状態である。
- stale な既存インデックスは自動 Full Index の対象にしない。
- 自動 Full Index は Runtime の起動完了を待たせない。
- 同一 Runtime で自動 Full Index を再試行しない。
- Full Index が例外なく終わっても DLQ に項目が残れば、正常完了として扱わない。
- 既存の `nexus --reindex` と `nexus --reindex --full` が成功し、DLQ が空なら、
  どちらも正常完了として記録する。
- 新しい CLI オプション、MCP Tool、API、UI は追加しない。

## 完了状態

既存 SQLite メタデータの `index_stats` を完了状態の唯一の情報源にする。

- `lastIndexedAt` が `null`、または `index_stats` 行が存在しない場合は未インデックス。
- 成功かつ DLQ が空の reindex の完了時にのみ `lastIndexedAt` を更新する。
- Full reindex の成功時は `lastFullScanAt` も更新する。
- 通常 reindex の成功時は、既存行の `lastFullScanAt` をそのまま保持する。既存行がない場合の
  `lastFullScanAt` の初期値は `null` とする。
- `totalFiles` と `totalChunks` は、成功時点の Vector Store 統計で更新する。
- `overflowCount` は既存値を維持し、既存行がない場合は `0` とする。

この方式は、空のプロジェクト、途中で停止した処理、部分的に残った Merkle
ノードやベクタを、成功済みのインデックスと誤認しない。既存の
`lastIndexedAt` と `lastFullScanAt` を利用するため、スキーマ変更や別マーカー
ファイルは不要である。

### 既存データの移行

現行バージョンは `lastIndexedAt` を書き込んでいないため、更新前に作られた
インデックスは正常完了を証明できない。新バージョンの最初の通常サービス起動では、
そのようなプロジェクトを未インデックスとして一度だけ自動 Full Index の対象にする。

これは過去の部分的なデータを正常完了と誤認しないための正確性優先の移行である。
この Full Index が成功し DLQ が空になった後は完了日時が保存されるため、以後は
既存の stale index を自動 Full Index しない。

## 構成

### IndexPipeline

`IndexPipeline` は reindex の成功記録を一元化する。

1. 既存の scan とイベント処理を完了する。
2. post-reindex compact を実行する。compact の失敗は既存どおり非致命としてログに記録し、
   完了判定の失敗理由にはしない。
3. DLQ への追加・削除と共有する completion lock を取得し、Vector Store 統計を取得する。
4. lock を保持したまま、SQLite transaction 内で全永続 DLQ 項目を再確認し、空の場合だけ
   `index_stats` を更新する。この transaction が DLQ 判定と完了状態保存の単一原子境界である。
5. 例外、DLQ 残存、中断では、完了状態を保存しない。

完了判定の対象は今回の実行で生成した項目だけではなく、`dead_letter_queue` の全永続項目とする。
実行ごとの DLQ 識別子は追加しない。DLQ が残る場合は `pipelineProgress.lastError` に
`Full reindex incomplete: <count> dead-letter queue item(s) remain` を記録し、各項目を
`skippedFiles` の `filePath -> errorMessage` として反映する。同一パスに複数項目がある場合は、
永続 DLQ の作成日時が最も新しい項目の `errorMessage` を使用する。DLQ 回復または別の処理が
completion lock 解放後に項目を追加しても、次の完了判定で必ず検出される。

このため、手動 reindex と起動時自動 reindex は同じ成功条件を使用する。
手動 CLI の実行方法や戻り値の意味は変更しない。

### NexusRuntime

`NexusRuntime.initialize()` は、既存どおりメタデータストア、Vector Store、
起動時整合化、Pipeline、Watcher を初期化する。これらが完了した後にだけ、
`lastIndexedAt` を確認する。

未インデックスなら、既存の Full reindex 処理を開始する Promise を保持するが、
`initialize()` からは await しない。Promise の失敗は Runtime の初期化失敗に
せず、ログと Pipeline 状態へ記録する。既に完了日時があれば何もしない。

自動実行は `run({ fullScan: true, reason: 'startup-reconciliation' })` として起動する。
手動 CLI と MCP Tool が使う reindex は引き続き `reason: 'manual'` とする。開始・完了・失敗の
ログにはこの実行由来を含める。Runtime は rejection handler を Promise の生成時に接続して
未処理 rejection を防ぎ、失敗内容を `pipelineProgress.lastError` とログへ記録する。

Runtime の初期化は既存の stdio、`serve`、managed HTTP の共通境界であるため、
各 transport に固有の分岐を追加しない。

`NexusRuntime.close()` は新規 Watcher イベントの受付を停止してから Pipeline に中断を通知し、
保持した自動 reindex Promise が fulfilled または rejected になるまで待機する。その後にだけ
metadata store と Vector Store を閉じる。停止による rejection は記録済みとして扱い、
`close()` 自身の未処理 rejection にしない。中断した自動処理は完了日時を保存しない。

## 状態遷移

### 未インデックス

統計行がない、または `lastIndexedAt` が `null` の状態である。完了日時はなく、
`index_status.indexStats` で確認できる。

### 自動実行中

未インデックスの Runtime が Full reindex を開始した状態である。完了日時はなく、
`pipelineProgress.status: "running"` と開始ログで確認できる。

### 正常完了

reindex が成功し DLQ が空の状態である。`lastIndexedAt` と、Full reindex なら
`lastFullScanAt` を保存する。`pipelineProgress.status: "idle"`、完了日時、完了ログで
確認できる。

### 失敗

例外または DLQ 残存で完了日時を保存しない状態である。`pipelineProgress.lastError`、
失敗ログ、DLQ が残る場合の `skippedFiles` で確認できる。DLQ 残存時の `lastError` は
`Full reindex incomplete: <count> dead-letter queue item(s) remain` とする。

### 停止

Runtime が実行中の Pipeline を停止した状態である。完了日時は保存せず、既存の停止処理と
ログで確認できる。

DLQ 回復ループが後から項目を処理しても、その事実だけで初回完了状態を記録しない。
次回の通常サービス起動時に未インデックスとして Full Index を再試行する。

## 競合とライフサイクル

- Runtime は初期自動処理の Promise を一度だけ生成する。
- Pipeline の既存 mutex は、自動 reindex と手動 reindex の同時実行を防ぐ。
  後続の reindex は既存どおり `already_running` となる。
- 起動時 Full Index 中も Watcher は稼働する。scan 開始後に発生した Watcher イベントは
  起動時 Full Index 専用の post-scan queue に保持し、Runtime が稼働を継続する場合は scan の成功・
  失敗を問わず Pipeline mutex 解放後に通常のイベント処理として drain する。既存 overflow recovery の
  イベント破棄契約は
  この post-scan queue には適用しない。
- `markFullScanComplete()` は scan の終端を通知するだけで、post-scan queue を消去してはならない。
  これは成功、例外、中断のいずれでも同じである。停止時は queue の drain を開始せず、Runtime の停止処理が
  queue を所有する。強制的なプロセス終了で処理できなかった場合を含め、完了日時を保存しないため、次回の
  通常サービス起動で Full Index を再試行する。
- プロセス間では、既存の `nexus.pid`、プロジェクトロック、Bridge の起動ロック、
  managed HTTP サーバー再利用により、同一プロジェクトの Runtime を一つに収束する。
- Runtime 終了時は既存の Pipeline 停止処理が実行中の処理を中断する。中断した
  自動処理を同一プロセス内で再開または再試行しない。

これにより、同一プロジェクトの起動時自動 Full Index は同時に最大一つとなる。

## 可観測性

新しい可観測性インターフェースは追加しない。

- 開始、完了、失敗、DLQ 残存は既存の `indexer.log` に実行由来（`startup-reconciliation` または
  `manual`）を含めて記録する。
- `index_status` は既存の `pipelineProgress`、`indexStats`、`skippedFiles` を返す。
- 実行中は `pipelineProgress.status`、成功は完了日時、失敗は `lastError` と
  `skippedFiles` から判断できる。

## テスト

- Pipeline の単体テストで、DLQ が空の成功した通常 reindex と Full reindex が
  正しい統計・日時を保存することを確認する。通常 reindex では既存の `lastFullScanAt` を
  保持し、新規統計行では `lastFullScanAt: null` となることも確認する。
- Pipeline の単体テストで、例外、DLQ 残存、停止時に完了日時が保存されないことを確認する。
- Pipeline の単体テストで、DLQ 残存時に安定した `lastError`、`skippedFiles`、未保存の完了日時を
  確認する。既存 DLQ、完了判定と保存の間に追加される DLQ、および DLQ recovery loop との競合を
  含める。
- Pipeline の単体テストで、compact 失敗がログに記録される非致命エラーであり、DLQ が空なら
  完了状態を保存することを確認する。
- EventQueue と Pipeline の単体または統合テストで、起動時 Full Index 中の Watcher イベントが
  post-scan queue に残り、成功・失敗・停止時の `markFullScanComplete()` が当該イベントを破棄せず、
  Runtime が稼働を継続する成功・失敗時には scan 終了後に処理されることを確認する。
- Runtime の単体テストで、未インデックス時に Full reindex が一度開始され、
  その完了を `initialize()` が待たないこと、`startup-reconciliation` の理由が渡されることを
  制御可能な Promise で確認する。
- Runtime の単体テストで、自動 reindex の rejection が未処理にならず、ログと Pipeline 状態に
  記録されること、および `close()` が Promise の完了後にのみ store を閉じることを確認する。
- Runtime の単体テストで、完了日時がある場合と stale な既存インデックスの場合に
  自動 Full Index が開始されないことを確認する。
- Runtime の単体テストで、更新前に作られ完了日時が未記録のデータは、最初の
  新バージョン起動で一度だけ自動 Full Index の対象になることを確認する。
- 共通 Runtime 初期化境界のテストを主軸にし、stdio、`serve`、managed HTTP、
  `http-bridge` の既存起動契約テストを維持する。
- 複数の通常起動経路が同一 Runtime インスタンスへ収束し、自動 Full Index が一度だけ起動される
  ことを単体または統合テストで確認する。

実装時の検証コマンドは、対象 Vitest、`npm run lint`、`npm run build`、全 Vitest とする。

## 対象外

- stale index の起動時 Full rebuild
- 同一プロセス内での自動 Full Index 再試行
- インデックス完了までの検索待機、拒否、キューイング
- Watcher の通常更新仕様の変更
- 新規 UI、MCP Tool、API、CLI オプション
- 本機能と無関係なリファクタリング
