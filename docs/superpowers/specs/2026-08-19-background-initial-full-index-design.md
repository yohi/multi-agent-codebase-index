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

1. 既存の scan、イベント処理、compact 処理を完了する。
2. DLQ の項目数を取得する。
3. DLQ が空の場合だけ、Vector Store 統計と完了日時を `index_stats` に保存する。
4. 例外、DLQ 残存、中断では、完了状態を保存しない。

このため、手動 reindex と起動時自動 reindex は同じ成功条件を使用する。
手動 CLI の実行方法や戻り値の意味は変更しない。

### NexusRuntime

`NexusRuntime.initialize()` は、既存どおりメタデータストア、Vector Store、
起動時整合化、Pipeline、Watcher を初期化する。これらが完了した後にだけ、
`lastIndexedAt` を確認する。

未インデックスなら、既存の Full reindex 処理を開始する Promise を保持するが、
`initialize()` からは await しない。Promise の失敗は Runtime の初期化失敗に
せず、ログと Pipeline 状態へ記録する。既に完了日時があれば何もしない。

Runtime の初期化は既存の stdio、`serve`、managed HTTP の共通境界であるため、
各 transport に固有の分岐を追加しない。

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
失敗ログ、DLQ が残る場合の `skippedFiles` で確認できる。

### 停止

Runtime が実行中の Pipeline を停止した状態である。完了日時は保存せず、既存の停止処理と
ログで確認できる。

DLQ 回復ループが後から項目を処理しても、その事実だけで初回完了状態を記録しない。
次回の通常サービス起動時に未インデックスとして Full Index を再試行する。

## 競合とライフサイクル

- Runtime は初期自動処理の Promise を一度だけ生成する。
- Pipeline の既存 mutex は、自動 reindex と手動 reindex の同時実行を防ぐ。
  後続の reindex は既存どおり `already_running` となる。
- プロセス間では、既存の `nexus.pid`、プロジェクトロック、Bridge の起動ロック、
  managed HTTP サーバー再利用により、同一プロジェクトの Runtime を一つに収束する。
- Runtime 終了時は既存の Pipeline 停止処理が実行中の処理を中断する。中断した
  自動処理を同一プロセス内で再開または再試行しない。

これにより、同一プロジェクトの起動時自動 Full Index は同時に最大一つとなる。

## 可観測性

新しい可観測性インターフェースは追加しない。

- 開始、完了、失敗、DLQ 残存は既存の `indexer.log` に自動起動であることを含めて記録する。
- `index_status` は既存の `pipelineProgress`、`indexStats`、`skippedFiles` を返す。
- 実行中は `pipelineProgress.status`、成功は完了日時、失敗は `lastError` と
  `skippedFiles` から判断できる。

## テスト

- Pipeline の単体テストで、DLQ が空の成功した通常 reindex と Full reindex が
  正しい統計・日時を保存することを確認する。
- Pipeline の単体テストで、例外、DLQ 残存、停止時に完了日時が保存されないことを確認する。
- Runtime の単体テストで、未インデックス時に Full reindex が一度開始され、
  その完了を `initialize()` が待たないことを制御可能な Promise で確認する。
- Runtime の単体テストで、完了日時がある場合と stale な既存インデックスの場合に
  自動 Full Index が開始されないことを確認する。
- Runtime の単体テストで、更新前に作られ完了日時が未記録のデータは、最初の
  新バージョン起動で一度だけ自動 Full Index の対象になることを確認する。
- 共通 Runtime 初期化境界のテストを主軸にし、stdio、`serve`、managed HTTP、
  `http-bridge` の既存起動契約テストを維持する。

実装時の検証コマンドは、対象 Vitest、`npm run lint`、`npm run build`、全 Vitest とする。

## 対象外

- stale index の起動時 Full rebuild
- 同一プロセス内での自動 Full Index 再試行
- インデックス完了までの検索待機、拒否、キューイング
- Watcher の通常更新仕様の変更
- 新規 UI、MCP Tool、API、CLI オプション
- 本機能と無関係なリファクタリング
