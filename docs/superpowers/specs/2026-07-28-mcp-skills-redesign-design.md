# MCP × Agent Skills 役割分離・再設計 設計書

## 1. 背景と目的

### 1.1 背景

- `AGENTS.md` は肥大化（93行）しており、常駐コンテキストとして AI エージェントのトークン消費を圧迫している。
- 同時に、コード探索・変更タスクにおけるツール選択（Nexus MCP と CodeGraph の使い分け）が手順書の文中に散在しており、AI が迷いやすい構造になっている。

### 1.2 目的

- システムの「接続・実行基盤（MCP）」と「タスク手順・動的コンテキスト（Skills）」を分離する。
- CodeGraph の優れた設計（明確なトリガー判定、One-Call Completeness、Deferred Loading）を取り入れ、**トークンコスト削減**と**ツール選択精度向上**を両立させる。
- 最優先の成功基準は **AI がコード探索タスクで正しいツールを迷わず選択できるようになること**。

## 2. レイヤー構成

```text
[ AI Agent ]
    │
    ├─ 1. Global Layer: AGENTS.md            ← 常駐、トリガー判定のみ（50行以内）
    ├─ 2. Procedure Layer: .agents/skills/   ← 動的ロード、タスク別最適パイプライン
    └─ 3. Execution Layer: Nexus MCP + 任意の CodeGraph  ← 実行・構造追跡
```

### 2.1 各レイヤーの役割

| レイヤー | コンポーネント | 役割 |
| --- | --- | --- |
| グローバル層 | `AGENTS.md` | プロジェクト基本制約と、タスク種別ごとのツール・スキル選択トリガーを決定論的に記述 |
| 知識・手順層 | `.agents/skills/*.md` | タスクごとの実行フロー標準化。Nexus と CodeGraph の役割分担、One-Call、Deferred Loading 手順を記述 |
| 実行・接続層 | `Nexus MCP` + 任意の CodeGraph | コード検索・ベクトルアクセス・ファイルコンテキスト取得。CodeGraph は `.codegraph/` が存在する場合のみ活用 |

## 3. `AGENTS.md` 軽量化案

目標は **50行以内**。含める要素は以下の4項目のみとする。

1. プロジェクト概要（2行）
2. 必須制約（3行）
   - セットアップ時は Source Build / Package Usage をユーザーに選択させる
   - マシン固有の絶対パス・認証情報・生成ローカル状態をコミットしない
   - 新規エージェント設定ファイル・ディレクトリを作成しない
3. ツール選択トリガー（5行程度）
   - コード調査・設計把握 → `.agents/skills/code-search.md`
   - `.codegraph/` がある場合の構造追跡 → `codegraph_explore`
   - 曖昧な検索・概念的調査 → `nexus/hybrid_search`
   - 正確なシンボル・エラー文字列 → `nexus/grep_search`
   - ファイル部分取得 → `nexus/get_context(startLine, endLine)`
4. 検証基本方針（2行）
   - コード変更後は Vitest の絞り込みテスト → `npm run lint`

既存の詳細な「Nexus MCP Usage Guidelines」は `.agents/skills/code-search.md` へ移動する。

## 4. `.agents/skills/code-search.md` 案

### 4.1 適用タイミング

以下のようなユーザー発話を受けたら本ファイルをロードする。

- 「〜を調べて」「〜の実装を探して」「〜の影響範囲を知りたい」
- バグ調査、リファクタリング前の影響範囲把握、設計レビュー

### 4.2 標準パイプライン

```text
Step 1: タスク分類
  → 抽象/概念調査？ 正確なシンボル追跡？ エラー原因特定？

Step 2: 存在するインデックスを使い分ける
  → .codegraph/ がある場合：codegraph_explore で構造・Call Tree を特定
  → 曖昧な検索：nexus/hybrid_search
  → 正確なシンボル/エラー文字列：nexus/grep_search

Step 3: ファイルコンテキスト取得
  → nexus/get_context(startLine, endLine) で最小範囲を取得
  → ファイル全体が必要な場合のみ全体取得

Step 4: 修正・回答へ移行
```

### 4.3 One-Call 行動パターン

- `hybrid_search` や `grep_search` のトップ候補に対して、結果を返す前に `get_context` を呼び出し、行番号範囲を絞ってまとめて返す。
- 検索とコンテキスト取得を別々の往復に分けない。

### 4.4 Deferred Loading

- 大きなファイルや大量の検索結果を扱う場合は「概要 + 行番号 + 必要に応じた取得コマンド」を優先し、全文を一括展開しない。

## 5. 実装フェーズ（PR単位）

| Phase | PR内容 | 変更ファイル | 価値 |
|---|---|---|---|
| Phase 1 | `AGENTS.md` 軽量化＆トリガー追記 | `AGENTS.md` | 常駐トークン削減、決定論的ルーティング |
| Phase 2 | `.agents/skills/code-search.md` 作成 | `.agents/skills/code-search.md` | 標準パイプライン共有、One-Call/Deferred Loading 手順化 |
| Phase 3 | Nexus MCP 側のチューニング | `src/mcp/*`、設定ファイル | インデックス除外、JSON Schema 最適化 |
| Phase 4 | 検証とイテレーション | テスト・ドキュメント | トークン消費・精度・Nexus 活用率の計測手順 |

各 Phase は独立してレビュー・マージ可能とする。

## 6. 後続 Feature タスク

### C. MCP 大規模改造型（将来検討）

B 完了後に別途計画・設計する、より大規模な API 拡張。

- `hybrid_search` のレスポンスに `includeSnippet` / `contextLines` 等のオプションを追加し、1回の呼び出しで「検索結果 + 前後コード」を返す。
- 長大なファイルの `get_context` に「概要 + 行番号 + 詳細取得コマンド」形式の Deferred Loading モードを追加。
- JSON Schema の description を最適化し、MCP 初期接続トークンを削減。

## 7. 検証方針

| 対象 | 検証内容 |
|---|---|
| `AGENTS.md` | 50行以内であること、マークダウン構文が壊れていないこと |
| `.agents/skills/code-search.md` | リンク切れがないこと、手順が循環していないこと |
| Phase 3 MCP 変更 | 既存の `npm run lint` と `npm test` が通ること |
| Phase 4 | 複合探索タスクで、トリガーに従って正しいツールが選択される手動検証シナリオを3件定義 |

## 8. 制約・前提

- CodeGraph は `.codegraph/` が存在する場合のみ活用する。存在しない場合は Nexus 単体でカバーする。
- SkillPort 形式への変換は別タスクとし、今回は通常のマークダウン手順書として作成する。
- 既存の Nexus ユーザーに破壊的変更を与えない。
