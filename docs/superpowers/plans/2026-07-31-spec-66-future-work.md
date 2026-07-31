# SPEC §6.6 Future Work 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Context**: 設計書 `docs/superpowers/specs/2026-07-31-mcp-future-work-design.md` に基づく。TDD を厳守する（RED → GREEN → REFACTOR）。テストフレームワークは Vitest、プロジェクトは TypeScript。

**Goal**: SPEC.md §6.6 の 2 拡張（`hybrid_search` のスニペット拡張、`get_context` の Deferred Loading モード）を後方互換で実装し、テスト・ドキュメントを更新する。

**Architecture**: 既存の MCP サーバー (`src/server/index.ts`) に optional Zod フィールドを追加。スニペットロジックは `executeHybridSearch` 内に配置（`SearchOrchestrator` 非接触）。共通ロジックは `src/server/tools/get-context.ts` から `resolveLineRange` / `sliceContent` を抽出して共有化。

**Tech Stack**: TypeScript 5.x, Vitest, Zod, Model Context Protocol (`@modelcontextprotocol/sdk`), Node.js >= 24

## Global Constraints

- **型安全性**: `as any` / `@ts-ignore` / `@ts-expect-error` を禁止する。既存の `any` キャストは `never` / proper types で置き換える。
- **TDD 厳守**: 本計画ではまず「失敗するテストを書いてからコードを書く」ルールを徹底する（RED フェーズを視認可能な形で残す）。
- **後方互換**: 新規パラメータは全て optional。既存の inputSchema required 配列・既存プロパティの意味・レスポンス shape は不変。
- **ファイル構成遵守**: 新規ファイル作成は機能拡張の核となる変更 (`src/server/tools/context-helpers.ts`, `src/server/tools/get-context-schema.ts` 等) を除き最小限に留める。エージェント設定ファイル (`.opencode/`, `claude.json` etc.) は作成禁止。
- **要求の制限**: タスクの変更対象は設計書または本計画に記載のものに限定する。余計なリファクタリングを行わない。
- **検証**: 各タスク完了時に `npm run lint` と該当する unit test を実行して局所的な整合性を担保する。

---

## Task 1: 共有スニペットヘルパー抽出

**Files:**

- Create: `src/server/tools/context-helpers.ts`
- Modify: `src/server/tools/get-context.ts` (internals only)
- Test: `tests/unit/server/tools/context-helpers.test.ts` (新規), `tests/unit/server/tools/get-context.test.ts` (既存テスト通過確認)

**Interfaces:**

- Produces:
  ```typescript
  // src/server/tools/context-helpers.ts
  export interface LineRange {
    startLine: number;
    endLine: number;
  }
  export const resolveLineRange = (totalLines: number, startLine?: number, endLine?: number): LineRange | null;
  export const sliceContent = (content: string, range: LineRange): string;
  ```
- Consumes: なし

**Steps:**

- [ ] **Step 1**: `tests/unit/server/tools/context-helpers.test.ts` を作成し、`resolveLineRange` と `sliceContent` の RED テストを書く。
  - `resolveLineRange` がクランプと `null` 返却 (逆転時) を正しく行うか。
  - `sliceContent` が正しく文字列を切り出すか。

  ```typescript
  import { describe, expect, it } from 'vitest';
  import { resolveLineRange, sliceContent } from '../../../../src/server/tools/context-helpers.js';

  describe('context-helpers', () => {
    describe('resolveLineRange', () => {
      it('resolves valid ranges', () => {
        expect(resolveLineRange(100, 2, 5)).toEqual({ startLine: 2, endLine: 5 });
      });
      it('clamps out of bounds ranges', () => {
        expect(resolveLineRange(5, 1, 20)).toEqual({ startLine: 1, endLine: 5 });
      });
      it('returns null for reversed ranges', () => {
        expect(resolveLineRange(5, 3, 2)).toBeNull();
      });
    });

    describe('sliceContent', () => {
      it('extracts correct lines', () => {
        const content = 'l1\nl2\nl3';
        expect(sliceContent(content, { startLine: 2, endLine: 2 })).toBe('l2');
      });
    });
  });
  ```

- [ ] **Step 2**: 作成したテストを実行して **RED になることを確認**する（`npx vitest run tests/unit/server/tools/context-helpers.test.ts`）。
  - 期待結果: エラー `Cannot find module ...` または import 失敗で失敗。

- [ ] **Step 3**: `src/server/tools/context-helpers.ts` を作成し、**`resolveLineRange` と `sliceContent`** を実装（GREEN 状態にする）。
  - `get-context.ts` 内の既存ロジックを参考にせず、直接テストの仕様を満たす最小実装にする。

- [ ] **Step 4**: テスト実行して **GREEN を確認**する（`npx vitest run tests/unit/server/tools/context-helpers.test.ts`）。

- [ ] **Step 5**: `src/server/tools/get-context.ts` を内部だけリファクタリングし、 `context-helpers.ts` を利用するように変更。
  - `resolveLineRange` が `null` を返した場合、既存の `Error` メッセージ形式 (`Invalid line range: startLine (${startLine}) is greater than endLine (${endLine})`) で throw する。
  - 既存の `get-context.test.ts` (挙動不変であることの確認) を実行。
  - この段階で get-context 自体のテストは GREEN を維持すること。

- [ ] **Step 6**: `get-context.test.ts` に `startLine > endLine` の既存エラー挙動を検証する RED テストを追加（Step 5 実装後に GREEN 化する）。
  - 例: `startLine: 3, endLine: 2` のとき `Invalid line range` を throw。

- [ ] **Step 7**: `npm run lint` を実行し、型安全性と lint エラーがないことを確認。

---

## Task 2: `hybrid_search` スニペット拡張

**Files:**

- Modify: `src/server/index.ts` (Zod schema + 呼び出し側)
- Modify: `src/server/tools/hybrid-search.ts` (ロジック追記)
- Modify: `src/server/tools/get-context.ts` (新規 helper のインポートと利用)
- Modify: `src/types/index.ts` (`SearchResponse` / `RankedResult` 拡張)
- Test: `tests/unit/server/tools/hybrid-search.test.ts` (RED/GREEN), `tests/integration/mcp-protocol.test.ts` (schema キー集合更新)

**Interfaces:**

- Produces:
  - `executeHybridSearch(orchestrator, sanitizer, loadFileContent, args, abortSignal?: AbortSignal)`
  - `HybridSearchToolArgs` 拡張 (`includeSnippet?: boolean`, `contextLines?: number`)
  - `SearchResponse.results[].snippet?: string` 等
- Consumes: `context-helpers.ts` (`resolveLineRange`), `src/server/path-sanitizer.ts`

**Steps:**

- [ ] **Step 1**: **`types/index.ts` を更新**
  - `RankedResult` へ `snippet?: string`, `snippetStartLine?: number`, `snippetEndLine?: number` を追加。
  - 既存の `SearchResponse` shape は壊さない（`results` 配列内のフィールド追加のみで、トップレベルは不変）。
  - `npm run lint` で型解決を確認。

- [ ] **Step 2**: `tests/integration/mcp-protocol.test.ts` を **RED の方向へ変更**（スキーマキー集合に `includeSnippet`, `contextLines` を含むようにリストを書き換えるが、実装していないため失敗することを確認する）。
  - 具体的には、expected keys 集合を更新: `['contextLines', 'filePattern', 'filePatterns', 'grepPattern', 'includeSnippet', 'language', 'query', 'topK']`.
  - 結果: テスト失敗が確認できるか。これを RED として記録。

- [ ] **Step 3**: **`src/server/index.ts` の `hybrid_search` 定義に新スキーマフィールドを追加**.
  - `includeSnippet: z.boolean().optional()`.
  - `contextLines: z.number().int().positive().optional()`.
  - Zod description で「`contextLines` は最大 20 まで。超過分は clamp される」と記載する。

- [ ] **Step 4**: **`src/server/index.ts` の `hybrid_search` ハンドラ呼び出しを更新**.
  - `executeHybridSearch(options.orchestrator, options.sanitizer, options.loadFileContent, args, extra?.signal)` の順に引数を渡す。
  - 既存の `extra?.signal` は最後の引数として保持する。

- [ ] **Step 5**: `tests/unit/server/tools/hybrid-search.test.ts` に **RED テストを追加**.
  - Case 1: `includeSnippet: false` (未指定) 時、結果に `snippet` が含まれない。
  - Case 2: `includeSnippet: true` かつ `contextLines: 1` 時、正しく前後行が抽出される。
  - Case 3: `includeSnippet: true` ときの `contextLines` が 20 を超える場合に clamp される（e.g. 50 → 20）。
  - Case 4: 同一ファイルで複数 chunk を取得した場合でも `loadFileContent` が 1 回で済むこと。
  - Case 5: ファイル読込失敗時、その結果の snippet 系フィールドは省略され、検索結果は維持される。

  ```typescript
  it('does not attach snippets when includeSnippet is false', async () => {
    const orchestrator = new StubOrchestrator(response);
    const loader = () => Promise.resolve('content');
    const result = await executeHybridSearch(
      orchestrator,
      sanitizer,
      loader,
      { query: 'test', includeSnippet: false },
    );
    expect(result.results[0]?.snippet).toBeUndefined();
  });
  // ... 各テスト
  ```

- [ ] **Step 6**: `src/server/tools/hybrid-search.ts` の **GREEN 実装**。
  - `executeHybridSearch` の引数に `loadFileContent: (path) => Promise<string>` を追加。
  - `includeSnippet` / `contextLines` を `args` から分離し、`SemanticSearchParams` に流さない。
  - `if (args.includeSnippet)` ブロックで `Map<string, string | null>` キャッシュを導入。
  - 各 `result.chunk` について、読み込んだファイル内容の行数 `lines.length` を使い、以下の範囲で `resolveLineRange` を呼び出す：
    ```typescript
    resolveLineRange(
      lines.length,
      Math.max(1, chunk.startLine - contextLines),
      Math.min(lines.length, chunk.endLine + contextLines),
    );
    ```
  - `resolveLineRange` が `null` の場合は snippet 系フィールドをセットしない。
  - `contextLines` の最大値は `MAX_CONTEXT_LINES = 20` にクランプする。
  - ファイル読込失敗時はキャッシュに `null` を記録し、その結果の snippet フィールドをスキップ。

- [ ] **Step 7**: **GREEN 確認**。
  - `npx vitest run tests/unit/server/tools/hybrid-search.test.ts` が全て成功 (`pass`).
  - `tests/integration/mcp-protocol.test.ts` を実行してスキーマが一致していることを確認（Step 2 で RED だったものが GREEN になる）。

- [ ] **Step 8**: Lint チェック (`npm run lint`).
  - 特に型エラーや未使用の import を検出しないように。

- [ ] **Step 9**: Commit (`feat: hybrid_search のスニペット機能を追加`).

---

## Task 3: `get_context` Deferred Loading

**Files:**

- Create: `src/server/tools/get-context-schema.ts` (Zod schema + inferred 型)
- Modify: `src/server/index.ts` (schema + metrics variant 分岐)
- Modify: `src/server/tools/get-context.ts` (discriminated union result type 定義と logic)
- Test: `tests/unit/server/tools/get-context.test.ts` (RED/GREEN), `tests/integration/mcp-protocol.test.ts` (schema キー更新), `tests/unit/observability/metrics-collector.test.ts` もしくは `tests/unit/server/index.test.ts` (metrics)

**Interfaces:**

- Produces:
  - `GetContextToolArgs` / `GetContextInputSchema` shared via `src/server/tools/get-context-schema.ts`
  - `GetContextToolArgs.mode?: 'eager' | 'deferred'` (default 'eager')
  - `GetContextResult` が union 型になる。
    ```typescript
    // eager variant
    { filePath: string; content: string; startLine: number; endLine: number; }
    // deferred variant
    { filePath: string; mode: 'deferred'; totalLines: number; summary: string; previewStartLine: number; previewEndLine: number; hint: string; }
    ```
- Consumes: `context-helpers.ts` (`resolveLineRange`, `sliceContent`)

**Steps:**

- [ ] **Step 1**: **`src/server/tools/get-context-schema.ts` を作成**。
  - `get_context` の Zod inputSchema をここに定義し、export する。
  - `export type GetContextToolArgs = z.infer<typeof getContextInputSchema>` もここに定義する。
  - `mode` は `z.enum(['eager', 'deferred']).optional().default('eager')` とし、`eager` を既定値とする。

- [ ] **Step 2**: **`src/server/index.ts` と `src/server/tools/get-context.ts` で上記 schema をインポート**。
  - `src/server/index.ts`: `get_context` ツール登録時に `inputSchema` として shared schema を使用する。
  - `src/server/tools/get-context.ts`: `GetContextToolArgs` 型として `z.infer<typeof getContextInputSchema>` を使用する。
  - default behavior (`eager`) は shared schema の `.default('eager')` で担保する。

- [ ] **Step 3**: **`src/server/index.ts` の `get_context` handler で metrics 計算を variant 判定に変更**。
  - eager variant の場合: `result.endLine - result.startLine + 1`
  - deferred variant の場合: `result.previewEndLine - result.previewStartLine + 1`
  - TypeScript の narrowing で `content in result` や `mode === 'deferred'` を使い、NaN / undefined 演算を防ぐ。

- [ ] **Step 4**: `tests/integration/mcp-protocol.test.ts` を **RED の方向へ変更**して `get_context` schema キー集合を反映。
  - expected keys: `['endLine', 'filePath', 'mode', 'startLine', 'symbolName']`.

- [ ] **Step 5**: `tests/unit/server/tools/get-context.test.ts` に Deferred Mode の RED テストを追加。
  - Case 1: `mode: 'deferred'` かつ start/endLine 未指定の場合、最初の `PREVIEW_LINES` 行だけがプレビューとして返る。
  - Case 2: `mode: 'deferred'` かつ range 指定があり、それが preview 範囲を上書きすることを確認。
  - Case 3: ファイル内の存在しないパス指定でエラーになる（deferred でも sanitization が同じように行われる）。
  - Case 4: `mode: 'deferred'` 時に `content` / `startLine` / `endLine` が含まれないことを確認。

- [ ] **Step 6**: **`src/server/tools/get-context.ts` を GREEN の実装へ**。
  - `executeGetContext` の引数型を `GetContextToolArgs` (shared schema infer) に更新。
  - `args.mode === 'deferred'` 時は preview 範囲を計算し、deferred variant を返す。
  - preview 範囲:
    - `startLine` / `endLine` 両方指定: 要求範囲をファイル境界にクランプ
    - `startLine` のみ指定: `startLine` から `min(startLine + PREVIEW_LINES - 1, totalLines)`
    - `endLine` のみ指定: `max(1, endLine - PREVIEW_LINES + 1)` から `endLine`
    - 両方未指定: `1` から `min(PREVIEW_LINES, totalLines)`
  - 範囲逆転時は既存の `Error` 形式を throw する。

- [ ] **Step 7**: **GREEN 確認**。
  - `tests/unit/server/tools/get-context.test.ts`
  - `tests/integration/mcp-protocol.test.ts`

- [ ] **Step 8**: metrics variant 分岐のテスト追加。
  - `tests/unit/server/index.test.ts` または該当箇所に、`mode: 'deferred'` 呼び出し時に `onContextLinesFetched` が preview 範囲の行数で呼ばれることを検証するテストを追加。

- [ ] **Step 9**: Lint チェック (`npm run lint`).

- [ ] **Step 10**: Commit (`feat: get_context の Deferred Loading モードを追加`).

---

## Task 4: ドキュメントと既存コードの整合（修正）

このタスクは実装の最後の確認とドキュメント修正として位置づけられます。特にエージェント向けガイドへの反映が含まれます。

**Files:**

- Modify: `docs/mcp-tools.md` (両ツールの説明文という形で追加)
- Modify: `SPEC.md` (§6.6 の文脈を現行実装ベースに変更)
- Modify: `.agents/skills/code-search.md` (新API利用方法への案内文)
- No code changes here (already finished logically in tasks 1-3).

**Steps:**

- [ ] **Step 1**: `docs/mcp-tools.md` を修正し、両ツール(`hybrid_search` & `get_context`)に対応する表と例を追記。
  - deferred 時の入力とデフォルト動作を日本語で明確に説明。
  - `contextLines` は正の整数を受け付け、20 を超える値は 20 にクランプされる旨を記載。

- [ ] **Step 2**: `SPEC.md` のセクション 6.6 を現行版に基づき更新。
  - 「今後の拡張」ではなく「実装された機能」へ変更。
  - コードベースへのリンクを `src/server/tools/hybrid-search.ts` / `src/server/tools/get-context.ts` / `src/server/tools/context-helpers.ts` に更新。

- [ ] **Step 3**: `.agents/skills/code-search.md` を改訂し、新しい `includeSnippet=true`, `get_context` (deferred mode) の使用指針を追記。
  - 例: サーバーが既に One-Call でスニペットを返すようになるため、エージェント側は追加の `get_context` 呼び出しを省略できるケースを追記。

- [ ] **Step 4**: `npm run lint` 及び全体テスト（全テスト合格必須）を実行。

- [ ] **Step 5**: 最終的に PR を作成可能な状態に仕上げる（`CHANGELOG.md`, `.changeset` が存在するなら更新検討）。
  - スコープに応じて既存のドキュメンテーション スタイル（日本語 / Conventional Commits）を厳守すること。

## Verification steps

1. **Unit Tests**: `npx vitest run tests/unit/server/tools/context-helpers.test.ts tests/unit/server/tools/hybrid-search.test.ts tests/unit/server/tools/get-context.test.ts`
2. **Integration Tests**: `npx vitest run tests/integration/mcp-protocol.test.ts`
3. **Lint**: `npm run lint`
4. **Full Test Suite**: `npx vitest run`

## Notes on Safety

- **Path Safety**: すべてのファイルシステムアクセスにおいて既存の `PathSanitizer` によりパス正規化と絶対パス検証が行われることを前提とする。
- **Concurrency**: `includeSnippet=true` のケースでは、複数のクエリが同時に走ることが予想されるため、並列アクセスを避けるために実装時に注意する（現在はシングルスレッドの async/await を想定）。

---
