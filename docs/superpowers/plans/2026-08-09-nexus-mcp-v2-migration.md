# Nexus HTTP／MCP v2 移行（Phase 1 + Phase 2）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP プロトコル `2026-07-28` 準拠の SDK v2 ベース HTTP サーバー（`nexus serve`）を新設し、既存 v1 経路（stdio / http-bridge）を一切変更せずに共存させる。

**Architecture:** ツール定義を SDK 中立 DSL（`src/server/tools/registry/`）に抽出し、v1（zod v3）/ v2（zod v4）アダプタでそれぞれの SDK に変換する。v2 HTTP サーバーは `createMcpHandler(factory, { legacy: "reject" })` によるリクエストごとのステートレス構成で、SQLite / LanceDB / Watcher / Embedding は起動時に 1 つだけ構築してクロージャ共有する。ストレージは `src/storage/interfaces/` にインターフェースを集約し、`LocalContentStore` を新設する。

**Tech Stack:** TypeScript, Node.js >=24, `@modelcontextprotocol/sdk` v1（維持）, `@modelcontextprotocol/server` v2.0.0 / `@modelcontextprotocol/node` v2.0.0（新規）, zod v3.25（`zod` = v1 用, `zod/v4` サブパス = v2 用）, better-sqlite3, LanceDB, Vitest

**Spec:** `docs/superpowers/specs/2026-08-07-nexus-mcp-v2-migration-design.md`（以下「設計書」）

## Global Constraints

- Node.js >=24（package.json `engines` 固定値）。ESM。相対 import は `.js` 拡張子付き。
- v1 経路（`src/server/index.ts` の公開 API、stdio、`nexus http-bridge`）の既存テストは **1 件も変更しない**（設計書 §10.1）。全件パスが後方互換の証明。
- zod はルートに `zod@^3.25.76` を維持する。v1 アダプタは `import { z } from "zod"`、v2 アダプタのみ `import { z } from "zod/v4"`（zod 3.25 同梱の v4 classic サブパス。実在確認済み: `node_modules/zod/v4/classic`）。`zod` を v4 に上げる変更は本計画の範囲外。
- 依存方向ルール（設計書 §7.5）: `@modelcontextprotocol/server` の import は `server-factory.ts` と `v2-adapter.ts` のみ。`@modelcontextprotocol/node`（`toNodeHandler`）の import は `transport.ts` のみで、利用は `entry.ts` からのみ。Transport 層から Storage Adapter 層への直接 import 禁止。
- `nexus serve` は loopback（`127.0.0.1` / `localhost` / `::1`）のみ bind。非 loopback は fail-fast（設計書 §3.2）。`--allow-network` / 認証は Phase 3、本計画では実装しない。
- Local HTTP v2 は local-only（設計書 §6.1）: 外部 Embedding Provider（`openai-compat` / `bedrock`）を v2-http モードの `loadConfig` で拒否する。Package Mode（`NEXUS_PACKAGE_MODE=1`）の既存 bedrock 固定動作は変更しない。
- `Mcp-Session-Id` とセッション Map は使わない（`createMcpHandler` に委譲）。
- v2 経路のみ `topK ≤ 100`、`maxResults ≤ 1000` を既定上限とし、`.nexus.json` / 環境変数で上書き可能（設計書 §10.3）。v1 経路の入力契約は不変。
- ローカルファースト: ソースコード・インデックス・Embedding を外部送信しない実装にする。
- 型抑制（`as any` / `@ts-ignore` / `@ts-expect-error`）禁止。空 catch 禁止。
- コミットは日本語 Conventional Commits（例: `feat(server): …`）。各タスク末尾で 1 コミット。
- 検証コマンド: 単体 `npx vitest run <file>`、全体 `npm run lint` / `npx tsc --noEmit` / `npx vitest run` / `npm run build`、E2E `npm run test:e2e`（`NEXUS_E2E=1` ゲート、実ビルドを spawn）。

---

## File Structure

### 新設

```text
src/server/
  ├── errors.ts                          # Task 2: NexusErrorCode + classifyErrorMessage
  ├── http-v2/
  │   ├── net.ts                         # Task 10: isLoopbackHost 等の純粋関数
  │   ├── headers.ts                     # Task 10: Origin/Host 検証 + セキュリティヘッダ
  │   ├── server-factory.ts              # Task 11: createMcpHandler ベースの v2 ハンドラ
  │   ├── transport.ts                   # Task 12: toNodeHandler 変換（責務は変換のみ）
  │   ├── routes.ts                      # Task 12: /mcp, /health, /ready ディスパッチ
  │   └── entry.ts                       # Task 12: HTTP サーバー起動/停止ハンドル
  └── tools/
      ├── types.ts                       # Task 6: NexusServerOptions 移設 + ToolHandler 型
      ├── tool-support.ts                # Task 6: toolResult/errorResult 移設 + buildToolHandlers
      └── registry/
          ├── schemas-neutral.ts         # Task 4: SDK 中立スキーマ DSL
          ├── definitions.ts             # Task 5: 6 ツールの中立定義
          └── adapters/
              ├── v1-adapter.ts          # Task 7: 中立 → zod v3 + registerTool
              └── v2-adapter.ts          # Task 8: 中立 → zod v4 (.max() 付き) + registerTool
src/storage/
  ├── interfaces/
  │   ├── content-store.ts               # 既存（コミット済み・変更なし）
  │   ├── metadata-store.ts              # Task 3: IMetadataStore 系の移設先
  │   └── vector-store.ts                # Task 3: IVectorStore 系の移設先
  └── local/
      └── local-content-store.ts         # Task 9: LocalContentStore + Factory
src/bin/commands/
  └── serve.ts                           # Task 13: nexus serve サブコマンド
tests/shared/
  └── create-test-nexus-options.ts       # Task 6: インメモリ options ビルダ（新規テスト専用）
```

### 変更

```text
package.json                             # Task 1: SDK v2 依存追加
src/types/index.ts                       # Task 1: HttpConfig + Config.http、Task 3: 再エクポート化
src/config/index.ts                      # Task 1: transportMode + http ブロック + assertHttpV2Constraints
src/server/index.ts                      # Task 7: 登録を v1 アダプタ経由に置換（公開 API は維持）
src/server/tools/get-context-schema.ts   # Task 7: zod スキーマを廃止し型のみモジュール化
src/server/factory.ts                    # Task 9: ContentStore 生成と注入、Task 13: buildRuntimeOptions 抽出
src/bin/nexus.ts                         # Task 13: serve サブコマンド配線（動的 import のみ）
```

---

### Task 1: SDK v2 依存パッケージ追加と HTTP 設定ブロック

**Files:**
- Modify: `package.json`
- Modify: `src/types/index.ts`（`Config` インターフェース、`HttpConfig` 追加）
- Modify: `src/config/index.ts:6-12`（`LoadConfigOptions`）、`src/config/index.ts:89-184`（`loadConfig`）、`src/config/index.ts` 末尾（`assertHttpV2Constraints` / `isLoopbackHost`）
- Test: `tests/integration/config/http-v2-config.test.ts`（新設）

**Interfaces:**
- Consumes: 既存 `Config` / `LoadConfigOptions` / `loadConfig({ projectRoot, configFileName?, env? })`
- Produces:
  - `interface HttpConfig { host: string; port?: number | undefined; maxTopK: number; maxResultsLimit: number }`（`src/types/index.ts`）
  - `Config.http?: HttpConfig | undefined`（v2-http モードでのみ存在）
  - `LoadConfigOptions.transportMode?: 'stdio' | 'v1-http' | 'v2-http'`
  - `assertHttpV2Constraints(config: Config): void`、`isLoopbackHost(host: string): boolean`（`src/config/index.ts`）

- [ ] **Step 1: SDK v2 パッケージをインストール**

```bash
npm install @modelcontextprotocol/server@2.0.0 @modelcontextprotocol/node@2.0.0
npm install --save-dev @modelcontextprotocol/client@2.0.0
```

検証（2.0.0 が入り、ルート zod は v3 のままであること）:

```bash
node -e "console.log(require('@modelcontextprotocol/server/package.json').version)"   # Expected: 2.0.0
node -e "console.log(require('@modelcontextprotocol/node/package.json').version)"     # Expected: 2.0.0
node -e "console.log(require('zod/package.json').version)"                            # Expected: 3.25.x（v4 に上がっていないこと）
ls node_modules/zod/v4/classic >/dev/null && echo zod-v4-subpath-ok                   # Expected: zod-v4-subpath-ok
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/integration/config/http-v2-config.test.ts` を新規作成:

```typescript
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/index.js';

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot !== undefined) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

const freshProjectRoot = async (): Promise<string> => {
  projectRoot = await mkdtemp(path.join(tmpdir(), 'nexus-http-config-'));
  return projectRoot;
};

describe('loadConfig transportMode="v2-http"', () => {
  it('exposes http defaults only in v2-http mode', async () => {
    const root = await freshProjectRoot();
    const stdioConfig = await loadConfig({ projectRoot: root, env: {} });
    expect(stdioConfig.http).toBeUndefined();

    const serveConfig = await loadConfig({
      projectRoot: root,
      env: {},
      transportMode: 'v2-http',
    });
    expect(serveConfig.http).toEqual({
      host: '127.0.0.1',
      maxTopK: 100,
      maxResultsLimit: 1000,
    });
  });

  it('prioritizes env over .nexus.json over defaults', async () => {
    const root = await freshProjectRoot();
    await writeFile(
      path.join(root, '.nexus.json'),
      JSON.stringify({ http: { host: 'localhost', port: 9201, maxTopK: 50 } }),
    );

    const fileOnly = await loadConfig({ projectRoot: root, env: {}, transportMode: 'v2-http' });
    expect(fileOnly.http).toEqual({ host: 'localhost', port: 9201, maxTopK: 50, maxResultsLimit: 1000 });

    const envOverride = await loadConfig({
      projectRoot: root,
      env: { NEXUS_HTTP_HOST: '127.0.0.1', NEXUS_HTTP_MAX_TOP_K: '25' },
      transportMode: 'v2-http',
    });
    expect(envOverride.http).toEqual({ host: '127.0.0.1', port: 9201, maxTopK: 25, maxResultsLimit: 1000 });
  });

  it('rejects a non-loopback host in v2-http mode', async () => {
    const root = await freshProjectRoot();
    await expect(
      loadConfig({
        projectRoot: root,
        env: { NEXUS_HTTP_HOST: '0.0.0.0' },
        transportMode: 'v2-http',
      }),
    ).rejects.toThrow(/loopback/);
  });

  it('rejects external embedding providers in v2-http mode', async () => {
    const root = await freshProjectRoot();
    for (const provider of ['openai-compat', 'bedrock'] as const) {
      await expect(
        loadConfig({
          projectRoot: root,
          env: { NEXUS_EMBEDDING_PROVIDER: provider },
          transportMode: 'v2-http',
        }),
      ).rejects.toThrow(/local-only/);
    }
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run tests/integration/config/http-v2-config.test.ts`
Expected: FAIL（`transportMode` は未知のプロパティで `serveConfig.http` が `undefined` のため `toEqual` アサーションが失敗する）

- [ ] **Step 4: `HttpConfig` 型と `Config.http` を追加**

`src/types/index.ts` の末尾に追加:

```typescript
/** Local HTTP v2 (`nexus serve`) settings. Present only in v2-http transport mode. */
export interface HttpConfig {
  host: string;
  port?: number | undefined;
  /** v2 経路の topK 上限（設計書 §10.3、既定 100）。 */
  maxTopK: number;
  /** v2 経路の maxResults 上限（設計書 §10.3、既定 1000）。 */
  maxResultsLimit: number;
}
```

`Config` インターフェースに 1 行追加（`metricsPort?: number | undefined;` の直前）:

```typescript
  /** Present only when the config was loaded with transportMode="v2-http". */
  http?: HttpConfig | undefined;
```

- [ ] **Step 5: `loadConfig` に transportMode と http ブロックを追加**

`src/config/index.ts:6-12` の `LoadConfigOptions` を以下に置き換え:

```typescript
export interface LoadConfigOptions {
  projectRoot: string;
  configFileName?: string;
  env?: NodeJS.ProcessEnv;
  /** "v2-http" のときのみ HTTP v2 設定を読み込み、local-only 制約を適用する。 */
  transportMode?: 'stdio' | 'v1-http' | 'v2-http';
}
```

`loadConfig` 内の `indexing: { ... },` ブロック直後（`metricsPort:` の前）に挿入:

```typescript
    ...(options.transportMode === 'v2-http'
      ? {
          http: {
            host:
              asString(env.NEXUS_HTTP_HOST) ??
              validateString(fileConfig.http?.host) ??
              '127.0.0.1',
            port: asPortNumber(env.NEXUS_HTTP_PORT) ?? validatePortNumber(fileConfig.http?.port),
            maxTopK:
              asBoundedPositiveInt(env.NEXUS_HTTP_MAX_TOP_K, 4096) ??
              validateBoundedPositiveInt(fileConfig.http?.maxTopK, 4096) ??
              100,
            maxResultsLimit:
              asBoundedPositiveInt(env.NEXUS_HTTP_MAX_RESULTS_LIMIT, 65536) ??
              validateBoundedPositiveInt(fileConfig.http?.maxResultsLimit, 65536) ??
              1000,
          },
        }
      : {}),
```

`return projectName === undefined ? merged : { ...merged, projectName };`（`src/config/index.ts:183` 付近）の直前に挿入:

```typescript
  if (options.transportMode === 'v2-http') {
    assertHttpV2Constraints(merged);
  }
```

`src/config/index.ts` の末尾に追加:

```typescript
/**
 * True when the host string names a loopback interface.
 * Accepts 127.0.0.0/8 dotted quads, "localhost", and "::1" (brackets optional).
 */
export const isLoopbackHost = (host: string): boolean => {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
};

/**
 * Local HTTP v2 constraints (design doc §3.2 / §6.1). Runs only when the
 * config was loaded with transportMode="v2-http":
 * - host must be a loopback interface (fail-closed; --allow-network is Phase 3)
 * - external embedding providers are rejected (local-first contract)
 */
export function assertHttpV2Constraints(config: Config): void {
  if (config.http === undefined) {
    throw new Error('Local HTTP v2 requires the http config block (transportMode="v2-http").');
  }
  if (!isLoopbackHost(config.http.host)) {
    throw new Error(
      `Local HTTP v2 can only bind to a loopback interface (127.0.0.1, localhost, or ::1), ` +
        `but received "${config.http.host}".`,
    );
  }
  if (config.embedding.provider === 'openai-compat' || config.embedding.provider === 'bedrock') {
    throw new Error(
      `Local HTTP v2 is local-only: embedding.provider "${config.embedding.provider}" contacts ` +
        `external networks. Use "ollama" or "test".`,
    );
  }
}
```

- [ ] **Step 6: テストが通ることを確認**

Run: `npx vitest run tests/integration/config/http-v2-config.test.ts`
Expected: PASS（4/4）

- [ ] **Step 7: 既存設定テストの回帰確認と静的検査**

Run: `npx vitest run tests/unit/config/ && npm run lint && npx tsc --noEmit`
Expected: すべて exit 0

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/types/index.ts src/config/index.ts tests/integration/config/http-v2-config.test.ts
git commit -m "feat(config): HTTP v2 向け設定ブロックと SDK v2 依存パッケージを追加"
```

---

### Task 2: NexusErrorCode 分類モジュール

**Files:**
- Create: `src/server/errors.ts`
- Test: `tests/unit/server/errors.test.ts`

**Interfaces:**
- Consumes: なし（純粋関数）
- Produces:
  - `type NexusErrorCode`（11 コードの union。到達不能コードは型定義のみ — 設計書 §9.2）
  - `classifyErrorMessage(message: string): NexusErrorCode | undefined` — Task 8 の v2 アダプタが `structuredContent.error.code` 付与に使用

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/server/errors.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { classifyErrorMessage } from '../../../src/server/errors.js';

describe('classifyErrorMessage', () => {
  it('maps invalid line ranges to NEXUS_CONTENT_NOT_FOUND', () => {
    expect(classifyErrorMessage('Invalid line range: startLine (5) is greater than endLine (2)')).toBe(
      'NEXUS_CONTENT_NOT_FOUND',
    );
  });

  it('maps ENOENT-style messages to NEXUS_CONTENT_NOT_FOUND', () => {
    expect(classifyErrorMessage("ENOENT: no such file or directory, open 'x.ts'")).toBe(
      'NEXUS_CONTENT_NOT_FOUND',
    );
  });

  it('maps dimension mismatch messages to NEXUS_VECTOR_DIMENSION_MISMATCH', () => {
    expect(classifyErrorMessage('vector dimension 64 does not match 128')).toBe(
      'NEXUS_VECTOR_DIMENSION_MISMATCH',
    );
  });

  it('maps reindex-in-progress messages to NEXUS_INDEXING_IN_PROGRESS', () => {
    expect(classifyErrorMessage('already_running')).toBe('NEXUS_INDEXING_IN_PROGRESS');
    expect(classifyErrorMessage('Reindex already running: incremental')).toBe('NEXUS_INDEXING_IN_PROGRESS');
  });

  it('returns undefined for unclassified messages', () => {
    expect(classifyErrorMessage('boom')).toBeUndefined();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/unit/server/errors.test.ts`
Expected: FAIL（`src/server/errors.js` を解決できずモジュール解決エラー）

- [ ] **Step 3: `src/server/errors.ts` を実装**

```typescript
/**
 * Nexus error codes surfaced as structuredContent.error.code on the v2 HTTP
 * path (design doc §9.2). Codes whose producing feature is not yet
 * implemented are declared here but never fired in Phase 1+2.
 */
export type NexusErrorCode =
  | 'NEXUS_STORAGE_UNAVAILABLE'
  | 'NEXUS_VECTOR_DIMENSION_MISMATCH'
  | 'NEXUS_CONTENT_NOT_FOUND'
  | 'NEXUS_INDEXING_IN_PROGRESS'
  // Phase 3-5 (declared only; never fired yet)
  | 'NEXUS_AUTH_REQUIRED'
  | 'NEXUS_ACCESS_DENIED'
  | 'NEXUS_WORKSPACE_NOT_FOUND'
  | 'NEXUS_REVISION_NOT_READY'
  | 'NEXUS_SYNC_OUT_OF_ORDER'
  | 'NEXUS_SYNC_RECONCILE_REQUIRED'
  | 'NEXUS_RATE_LIMITED';

/**
 * Classify a sanitized error message into a Nexus error code.
 * Works on the message string (not the error object) because the v2 adapter
 * classifies after `errorResult()` has already sanitized the original error.
 * Returns undefined when no code applies — the response then keeps the
 * legacy shape without a `code` key (design doc §9.3).
 */
export const classifyErrorMessage = (message: string): NexusErrorCode | undefined => {
  if (message.startsWith('Invalid line range:')) {
    return 'NEXUS_CONTENT_NOT_FOUND';
  }
  if (message === 'already_running' || message.includes('Reindex already running')) {
    return 'NEXUS_INDEXING_IN_PROGRESS';
  }
  const lower = message.toLowerCase();
  if (lower.includes('dimension')) {
    return 'NEXUS_VECTOR_DIMENSION_MISMATCH';
  }
  if (lower.includes('enoent') || lower.includes('no such file')) {
    return 'NEXUS_CONTENT_NOT_FOUND';
  }
  return undefined;
};
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run tests/unit/server/errors.test.ts`
Expected: PASS（5/5）

- [ ] **Step 5: Commit**

```bash
git add src/server/errors.ts tests/unit/server/errors.test.ts
git commit -m "feat(server): NexusErrorCode 分類モジュールを追加"
```

---

### Task 3: Storage インターフェースの `src/storage/interfaces/` への移設

**Files:**
- Create: `src/storage/interfaces/metadata-store.ts`
- Create: `src/storage/interfaces/vector-store.ts`
- Modify: `src/types/index.ts`（移設分を再エクポートに置換）

**Interfaces:**
- Consumes: `src/types/index.ts` の既存インターフェース群
- Produces: 既存と同名の型を `src/storage/interfaces/` からも import 可能にする（`src/types/index.ts` 経由の既存 import はすべて無変更で動く）

- [ ] **Step 1: 移設対象シンボルの所在を確定**

Run:

```bash
grep -n "^export interface \(IMetadataStore\|MerkleNodeRow\|IndexStatsRow\|EmbeddingCacheEntry\|IVectorStore\|CompactionConfig\|CompactionMutex\|CompactionResult\|VectorStoreStats\)\|^export \(interface\|type\) \(VectorFilter\|VectorSearchResult\)" src/types/index.ts
```

Expected: 上記シンボルすべてが `src/types/index.ts` に存在する。`IMetadataStore` が参照する `DeadLetterEntry` と `IVectorStore` が参照する `CodeChunk` が別ファイル（例: `src/indexer/` 配下）で定義されていた場合は、その型は移設せず interfaces ファイルから `import type` する方針に切り替え、Step 2 のコード中の該当 import パスを調整する。

- [ ] **Step 2: 移設（定義の物理移動 + 再エクポート化）**

`src/types/index.ts` から次のシンボル定義を **カット** し、下記の通り配置する（定義本文は一字一句変更しない）:

- `src/storage/interfaces/metadata-store.ts`（新規）: `IMetadataStore`, `MerkleNodeRow`, `IndexStatsRow`, `EmbeddingCacheEntry`。ファイル先頭に `import type { DeadLetterEntry } from '../../types/index.js';`（Step 1 で所在確認したパス）を置く。
- `src/storage/interfaces/vector-store.ts`（新規）: `IVectorStore`, `CompactionConfig`, `CompactionMutex`, `CompactionResult`, `VectorFilter`, `VectorSearchResult`, `VectorStoreStats`。`CodeChunk` 等の外部型は `import type { CodeChunk } from '../../types/index.js';` を置く。

各ファイル先頭に 1 行コメントを付ける:

```typescript
/** Storage interfaces (design doc §7.3). Canonical home since the Phase 1b relocation; re-exported from src/types/index.ts for backward compatibility. */
```

`src/types/index.ts` のカットした箇所に再エクポートを残す:

```typescript
export type {
  IMetadataStore,
  MerkleNodeRow,
  IndexStatsRow,
  EmbeddingCacheEntry,
} from '../storage/interfaces/metadata-store.js';
export type {
  IVectorStore,
  CompactionConfig,
  CompactionMutex,
  CompactionResult,
  VectorFilter,
  VectorSearchResult,
  VectorStoreStats,
} from '../storage/interfaces/vector-store.js';
```

（型のみの再エクポートのため実行時の循環 import は発生しない。）

- [ ] **Step 3: 型検査と既存テストで回帰確認**

Run: `npx tsc --noEmit && npm run lint && npx vitest run tests/unit/storage/`
Expected: すべて exit 0。既存 import は再エクポート経由でそのまま解決される。

- [ ] **Step 4: Commit**

```bash
git add src/types/index.ts src/storage/interfaces/metadata-store.ts src/storage/interfaces/vector-store.ts
git commit -m "refactor(storage): MetadataStore/VectorStore インターフェースを interfaces/ へ移設"
```

---

### Task 4: SDK 中立スキーマ DSL

**Files:**
- Create: `src/server/tools/registry/schemas-neutral.ts`

**Interfaces:**
- Consumes: なし
- Produces: `NeutralField`, `NeutralSchema` — Task 5（definitions）と Task 7/8（adapters）が利用

このタスクは型 DSL のみで実行時動作を持たないため、TDD の「失敗するテスト」は型検査（`tsc`）が担う。実行時の等価性は Task 8 のスキーマパリティテストで担保する。

- [ ] **Step 1: `schemas-neutral.ts` を作成**

```typescript
/**
 * SDK-neutral tool input schema DSL (design doc §7.1).
 *
 * Tool definitions are authored once in this DSL; the v1 adapter compiles
 * them to zod v3 raw shapes and the v2 adapter to a zod v4 object schema.
 * Supported kinds are intentionally limited to the six shapes the existing
 * six tools use. Business-rule clamping stays in the execute* layer; the
 * optional `maximum` on integers is an input-validation cap applied only by
 * the v2 adapter (design doc §10.3).
 */
export type NeutralField =
  | { kind: 'string'; optional?: boolean; description?: string }
  | { kind: 'integer'; optional?: boolean; description?: string; maximum?: number }
  | { kind: 'number'; optional?: boolean; description?: string }
  | { kind: 'boolean'; optional?: boolean; description?: string; default?: boolean }
  | { kind: 'stringArray'; optional?: boolean; description?: string }
  | {
      kind: 'enum';
      values: [string, ...string[]];
      optional?: boolean;
      default?: string;
      description?: string;
    };

export type NeutralSchema = Record<string, NeutralField>;
```

- [ ] **Step 2: 型検査**

Run: `npx tsc --noEmit && npm run lint`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/server/tools/registry/schemas-neutral.ts
git commit -m "feat(server): SDK 中立スキーマ DSL を追加"
```

---

### Task 5: ツール定義レジストリ（6 ツールの中立定義）

**Files:**
- Create: `src/server/tools/registry/definitions.ts`
- Test: `tests/unit/server/tools/registry/definitions.test.ts`

**Interfaces:**
- Consumes: `NeutralField` / `NeutralSchema`（Task 4）
- Produces:
  - `interface ToolDefinition { name: ToolName; description: string; input: NeutralSchema }`
  - `type ToolName = 'semantic_search' | 'grep_search' | 'hybrid_search' | 'get_context' | 'index_status' | 'reindex'`
  - `TOOL_DEFINITIONS: readonly ToolDefinition[]`（登録順 = 現行 index.ts と同一）
  - 各ツール定義の名前付き export（`GET_CONTEXT_DEFINITION` 等）

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/server/tools/registry/definitions.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  GET_CONTEXT_DEFINITION,
  TOOL_DEFINITIONS,
} from '../../../../../src/server/tools/registry/definitions.js';

describe('tool definitions', () => {
  it('contains the 6 known tools in registration order', () => {
    expect(TOOL_DEFINITIONS.map((d) => d.name)).toEqual([
      'semantic_search',
      'grep_search',
      'hybrid_search',
      'get_context',
      'index_status',
      'reindex',
    ]);
  });

  it('mirrors the legacy get_context schema (mode enum defaults to eager)', () => {
    expect(GET_CONTEXT_DEFINITION.input.mode).toEqual({
      kind: 'enum',
      values: ['eager', 'deferred'],
      optional: true,
      default: 'eager',
      description:
        'Set to "deferred" to receive a short preview and hint instead of full content for large files.',
    });
  });

  it('caps topK and maxResults with v2 maximums (design §10.3)', () => {
    const hybrid = TOOL_DEFINITIONS.find((d) => d.name === 'hybrid_search');
    const grep = TOOL_DEFINITIONS.find((d) => d.name === 'grep_search');
    expect(hybrid?.input.topK).toMatchObject({ kind: 'integer', maximum: 100 });
    expect(grep?.input.maxResults).toMatchObject({ kind: 'integer', maximum: 1000 });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/unit/server/tools/registry/definitions.test.ts`
Expected: FAIL（`definitions.js` のモジュール解決エラー）

- [ ] **Step 3: `definitions.ts` を作成**

description / default / maximum の値は現行 `src/server/index.ts` の zod スキーマからの逐語コピーであること。

```typescript
import type { NeutralSchema } from './schemas-neutral.js';

/** The six Nexus tool names, in legacy registration order. */
export type ToolName =
  | 'semantic_search'
  | 'grep_search'
  | 'hybrid_search'
  | 'get_context'
  | 'index_status'
  | 'reindex';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  input: NeutralSchema;
}
```

(a) 続けて 6 定義を追加する。まず `semantic_search` / `grep_search`:

```typescript
export const SEMANTIC_SEARCH_DEFINITION: ToolDefinition = {
  name: 'semantic_search',
  description: 'Vector-only semantic search; prefer hybrid_search for most tasks.',
  input: {
    query: { kind: 'string' },
    topK: { kind: 'integer', optional: true, maximum: 100 },
    filePattern: { kind: 'string', optional: true },
    filePatterns: { kind: 'stringArray', optional: true },
    language: { kind: 'string', optional: true },
  },
};

export const GREP_SEARCH_DEFINITION: ToolDefinition = {
  name: 'grep_search',
  description: 'Exact string search for symbols, errors, or code fragments.',
  input: {
    pattern: { kind: 'string' },
    filePattern: { kind: 'string', optional: true },
    filePatterns: { kind: 'stringArray', optional: true },
    caseSensitive: { kind: 'boolean', optional: true },
    maxResults: { kind: 'integer', optional: true, maximum: 1000 },
  },
};
```

(b) `hybrid_search`（`contextLines` の description は現行スキーマからの逐語コピー）:

```typescript
export const HYBRID_SEARCH_DEFINITION: ToolDefinition = {
  name: 'hybrid_search',
  description: 'Semantic + grep hybrid search for vague or conceptual queries.',
  input: {
    query: { kind: 'string' },
    topK: { kind: 'integer', optional: true, maximum: 100 },
    filePattern: { kind: 'string', optional: true },
    filePatterns: { kind: 'stringArray', optional: true },
    language: { kind: 'string', optional: true },
    grepPattern: { kind: 'string', optional: true },
    includeSnippet: { kind: 'boolean', optional: true },
    contextLines: {
      kind: 'integer',
      optional: true,
      maximum: 20,
      description:
        'Lines of context to include before and after each match when includeSnippet is true. Maximum 20; values above are clamped.',
    },
  },
};
```

(c) `get_context` / `index_status` / `reindex` と配列 export:

```typescript
export const GET_CONTEXT_DEFINITION: ToolDefinition = {
  name: 'get_context',
  description: 'Return a specific line range from a file; prefer partial reads.',
  input: {
    filePath: { kind: 'string' },
    /** @deprecated reserved for future use */
    symbolName: { kind: 'string', optional: true },
    startLine: { kind: 'integer', optional: true },
    endLine: { kind: 'integer', optional: true },
    mode: {
      kind: 'enum',
      values: ['eager', 'deferred'],
      optional: true,
      default: 'eager',
      description:
        'Set to "deferred" to receive a short preview and hint instead of full content for large files.',
    },
  },
};

export const INDEX_STATUS_DEFINITION: ToolDefinition = {
  name: 'index_status',
  description: 'Check indexing progress and statistics before searching.',
  input: {},
};

export const REINDEX_DEFINITION: ToolDefinition = {
  name: 'reindex',
  description: 'Manually rebuild the local search index.',
  input: {
    fullRebuild: { kind: 'boolean', optional: true },
  },
};

/** All tool definitions in legacy registration order. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  SEMANTIC_SEARCH_DEFINITION,
  GREP_SEARCH_DEFINITION,
  HYBRID_SEARCH_DEFINITION,
  GET_CONTEXT_DEFINITION,
  INDEX_STATUS_DEFINITION,
  REINDEX_DEFINITION,
];
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run tests/unit/server/tools/registry/definitions.test.ts`
Expected: PASS（3/3）

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/registry/definitions.ts tests/unit/server/tools/registry/definitions.test.ts
git commit -m "feat(server): 6 ツールの中立定義レジストリを追加"
```

---

### Task 6: 共有ハンドラ層（types.ts / tool-support.ts）とテスト用 options ビルダ

**Files:**
- Create: `src/server/tools/types.ts`
- Create: `src/server/tools/tool-support.ts`
- Create: `tests/shared/create-test-nexus-options.ts`
- Modify: `src/server/index.ts`（`errorResult` / `toolResult` の再エクポート化のみ。登録ロジックの置換は Task 7）
- Test: `tests/unit/server/tools/tool-support.test.ts`

**Interfaces:**
- Consumes: 現行 `src/server/index.ts` の `NexusServerOptions`・`toolResult`・`errorResult`・各 `execute*`（`src/server/tools/*.ts`）、`withToolMetrics`（`src/server/tool-instrumentation.ts`）
- Produces:
  - `types.ts`: `NexusServerOptions`（index.ts からの移設）、`NexusToolCallResult`、`ToolHandlerExtras`、`ToolHandler`
  - `tool-support.ts`: `toolResult`, `errorResult`（index.ts からの移設）、`buildToolHandlers(options: NexusServerOptions, awaitInitialize?: () => Promise<void>): Record<ToolName, ToolHandler>`
  - テスト用: `createTestNexusOptions(): Promise<TestNexusContext>`（Task 7/8/11/12 のテストが利用）

- [ ] **Step 1: `types.ts` を作成**

`src/server/index.ts` から `NexusServerOptions` インターフェース定義（`grep -n \"interface NexusServerOptions\" src/server/index.ts` で開始行を特定し、`}` までのブロック全体）を **そのままカット** して `src/server/tools/types.ts` に貼り付ける（フィールド型の import も一緒に移し、相対パスを `../../` 基準に修正する）。続けてハンドラ型を追記:

```typescript
/** Tool call result shared by the v1/v2 adapters (structural subset of the SDKs' CallToolResult). */
export interface NexusToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface ToolHandlerExtras {
  readonly signal?: AbortSignal | undefined;
}

/** SDK-agnostic tool handler. Adapters wrap these into each SDK's callback shape. */
export type ToolHandler = (
  args: unknown,
  extra?: ToolHandlerExtras,
) => Promise<NexusToolCallResult>;
```

この時点では `src/server/index.ts` 内に同名インターフェースが残ったまま（別モジュールの同名型は合法）なのでコンパイルは通る。index.ts 側の切替は Task 7 で行う。

- [ ] **Step 2: `toolResult` / `errorResult` を `tool-support.ts` へ移設**

`src/server/index.ts` 末尾付近（`export const errorResult` / `export const toolResult`、496-528 行付近）の 2 関数を **一字一句変更せず** `src/server/tools/tool-support.ts` に移動する。`sanitizeErrorMessage` の import は `../../utils/error-utils.js` に修正する。

`src/server/index.ts` 側は定義を削除し、公開 API 維持のための再エクポートを追加:

```typescript
export { errorResult, toolResult } from './tools/tool-support.js';
```

- [ ] **Step 3: `buildToolHandlers` を実装**

`src/server/tools/tool-support.ts` に追記する。各ハンドラ本体は現行 `src/server/index.ts:128-318` の各 `registerTool` コールバックの **逐語コピー**（`withToolMetrics` の適用、メトリクス呼び出し、キャスト、`awaitInitialize` ガードの位置を含む）:

```typescript
import { withToolMetrics } from '../tool-instrumentation.js';
import { executeGetContext } from './get-context.js';
import { executeGrepSearch, type GrepSearchToolArgs } from './grep-search.js';
import { executeHybridSearch, type HybridSearchToolArgs } from './hybrid-search.js';
import { executeIndexStatus } from './index-status.js';
import { executeReindex } from './reindex.js';
import { executeSemanticSearch, type SemanticSearchToolArgs } from './semantic-search.js';
import type { GetContextToolArgs } from './get-context-schema.js';
import type { ToolName } from './registry/definitions.js';
import type { NexusServerOptions, ToolHandler } from './types.js';

/**
 * Build the six tool handlers from shared runtime options. Used by the v1
 * adapter (stdio / http-bridge) and the v2 adapter (nexus serve). Handler
 * bodies are verbatim extractions of the legacy inline callbacks in
 * src/server/index.ts — behavior must not diverge between transports.
 */
export const buildToolHandlers = (
  options: NexusServerOptions,
  awaitInitialize?: () => Promise<void>,
): Record<ToolName, ToolHandler> => ({
  semantic_search: withToolMetrics(
    'semantic_search',
    options.metricsHooks,
    async (args: unknown, extra?: { signal?: AbortSignal }) => {
      if (awaitInitialize) await awaitInitialize();
      try {
        const result = await executeSemanticSearch(
          options.semanticSearch,
          options.sanitizer,
          args as SemanticSearchToolArgs & { filePattern?: string },
          extra?.signal,
        );
        options.metricsHooks?.onSearchResults('semantic', result.results.length);
        return toolResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  ),
  grep_search: withToolMetrics(
    'grep_search',
    options.metricsHooks,
    async (args: unknown, extra?: { signal?: AbortSignal }) => {
      if (awaitInitialize) await awaitInitialize();
      try {
        const result = await executeGrepSearch(
          options.grepEngine,
          options.projectRoot,
          options.sanitizer,
          args as GrepSearchToolArgs,
          extra?.signal,
        );
        options.metricsHooks?.onSearchResults('grep', result.matches.length);
        return toolResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  ),
  hybrid_search: withToolMetrics(
    'hybrid_search',
    options.metricsHooks,
    async (args: unknown, extra?: { signal?: AbortSignal }) => {
      if (awaitInitialize) await awaitInitialize();
      try {
        const result = await executeHybridSearch(
          options.orchestrator,
          options.sanitizer,
          options.loadFileContent,
          args as HybridSearchToolArgs & { filePattern?: string },
          extra?.signal,
          options.metricsHooks,
        );
        options.metricsHooks?.onSearchResults('hybrid', result.results.length);
        return toolResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  ),
```


(a) `buildToolHandlers` の残り 3 ハンドラ（get_context / index_status / reindex）を同じ方針で追記:

```typescript
  get_context: withToolMetrics(
    'get_context',
    options.metricsHooks,
    async (args: unknown) => {
      if (awaitInitialize) await awaitInitialize();
      try {
        const result = await executeGetContext(
          options.loadFileContent,
          options.sanitizer,
          args as GetContextToolArgs,
        );
        const lineCount = 'mode' in result
          ? result.previewEndLine - result.previewStartLine + 1
          : result.endLine - result.startLine + 1;
        options.metricsHooks?.onContextLinesFetched('get_context', lineCount);
        return toolResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  ),
  index_status: withToolMetrics(
    'index_status',
    options.metricsHooks,
    async () => {
      if (awaitInitialize) await awaitInitialize();
      try {
        return toolResult(
          await executeIndexStatus(
            options.metadataStore,
            options.vectorStore,
            options.pluginRegistry,
            options.pipeline,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  ),
  reindex: withToolMetrics(
    'reindex',
    options.metricsHooks,
    async (args: unknown) => {
      if (awaitInitialize) await awaitInitialize();
      try {
        return toolResult(
          await executeReindex(
            options.pipeline,
            options.runReindex,
            options.loadFileContent,
            args as Parameters<typeof executeReindex>[3],
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  ),
});
```

注意: `withToolMetrics` のジェネリクス制約は `TResult extends { isError?: boolean }`。ハンドラの戻り値は `toolResult` / `errorResult` の返すオブジェクトリテラル型で制約を満たす。現行 index.ts の reindex ハンドラが `args` をキャストなしで渡しているかを `src/server/index.ts:301-312` で確認し、キャストが無ければ上記の `as Parameters<typeof executeReindex>[3]` を外して同じにする。

- [ ] **Step 4: テスト用 options ビルダを作成**

`tests/shared/create-test-nexus-options.ts`（`tests/integration/server.test.ts` の beforeEach と同等の構成を再利用可能な形にしたもの。既存テストは変更しない）:

```typescript
import path from 'node:path';

import { IndexPipeline } from '../../src/indexer/pipeline.js';
import { Chunker } from '../../src/indexer/chunker.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import { SearchOrchestrator } from '../../src/search/orchestrator.js';
import { SemanticSearch } from '../../src/search/semantic.js';
import { PathSanitizer } from '../../src/server/path-sanitizer.js';
import type { NexusServerOptions } from '../../src/server/tools/types.js';
import type { CodeChunk } from '../../src/types/index.js';
import { TestEmbeddingProvider } from '../unit/plugins/embeddings/test-embedding-provider.js';
import { TestGrepEngine } from '../unit/search/test-grep-engine.js';
import { InMemoryMetadataStore } from '../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../unit/storage/in-memory-vector-store.js';

export interface TestNexusContext {
  options: NexusServerOptions;
  metadataStore: InMemoryMetadataStore;
  vectorStore: InMemoryVectorStore;
  grepEngine: TestGrepEngine;
}

/**
 * In-memory NexusServerOptions fixture: one TypeScript file
 * (src/auth.ts, "export function authenticate() {}") indexed in both the
 * vector store and the grep engine. Shared by registry/adapter/http-v2
 * tests; existing tests are intentionally left untouched.
 */
export const createTestNexusOptions = async (): Promise<TestNexusContext> => {
  const projectRoot = process.cwd();
  const metadataStore = new InMemoryMetadataStore();
  const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
  await metadataStore.initialize();
  await vectorStore.initialize();

  const embeddingProvider = new TestEmbeddingProvider();
  const pluginRegistry = new PluginRegistry();
  pluginRegistry.registerLanguage(new TypeScriptLanguagePlugin());
  pluginRegistry.registerEmbeddingProvider('test', embeddingProvider);
  pluginRegistry.setActiveEmbeddingProvider('test');

  const semanticSearch = new SemanticSearch({ vectorStore, embeddingProvider });
  const grepEngine = new TestGrepEngine();
  grepEngine.addFile('src/auth.ts', 'export function authenticate() {}\n');

  const chunk: CodeChunk = {
    id: 'src/auth.ts:1',
    filePath: 'src/auth.ts',
    content: 'export function authenticate() {}',
    language: 'typescript',
    symbolName: 'authenticate',
    symbolKind: 'function',
    startLine: 1,
    endLine: 1,
    hash: 'hash-1',
  };
  await vectorStore.upsertChunks([chunk], await embeddingProvider.embed([chunk.content]));

  const orchestrator = new SearchOrchestrator({ semanticSearch, grepEngine, projectRoot });
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker: new Chunker(pluginRegistry),
    embeddingProvider,
    pluginRegistry,
  });

  const sanitizer = await PathSanitizer.create(projectRoot);

  const options: NexusServerOptions = {
    projectRoot,
    sanitizer,
    semanticSearch,
    grepEngine,
    orchestrator,
    vectorStore,
    metadataStore,
    pipeline,
    pluginRegistry,
    runReindex: async () => [],
    loadFileContent: async (filePath: string) => {
      const relativePath = path.relative(projectRoot, filePath);
      if (relativePath === 'src/auth.ts' || filePath === 'src/auth.ts') {
        return 'export function authenticate() {}\n';
      }
      throw new Error(`unexpected file: ${filePath}`);
    },
  };

  return { options, metadataStore, vectorStore, grepEngine };
};
```

- [ ] **Step 5: 失敗するテストを書く**

`tests/unit/server/tools/tool-support.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { buildToolHandlers } from '../../../../src/server/tools/tool-support.js';
import { createTestNexusOptions } from '../../../shared/create-test-nexus-options.js';

describe('buildToolHandlers', () => {
  it('returns handlers for all six tools', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers(options);
    expect(Object.keys(handlers).sort()).toEqual([
      'get_context',
      'grep_search',
      'hybrid_search',
      'index_status',
      'reindex',
      'semantic_search',
    ]);
  });

  it('grep_search returns matches as structuredContent', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers(options);
    const result = await handlers.grep_search({ pattern: 'authenticate' });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { matches: Array<{ filePath: string }> };
    expect(structured.matches).toHaveLength(1);
    expect(structured.matches[0]?.filePath).toBe('src/auth.ts');
  });

  it('get_context on an unknown file returns isError with the legacy shape (no code)', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers(options);
    const result = await handlers.get_context({ filePath: 'nope.ts' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: true });
    expect(result.structuredContent).not.toHaveProperty('code');
  });

  it('awaits initialization before executing', async () => {
    const { options } = await createTestNexusOptions();
    const calls: string[] = [];
    const handlers = buildToolHandlers(options, async () => {
      calls.push('init');
    });
    await handlers.index_status({});
    expect(calls).toEqual(['init']);
  });
});
```

- [ ] **Step 6: テストを実行して確認（純粋な抽出移動のため初回 PASS が期待値）**

Run: `npx vitest run tests/unit/server/tools/tool-support.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS（4/4）、tsc / lint exit 0。失敗した場合は移動時に本文を書き換えてしまっているので、index.ts のオリジナルと diff を取って修正する。

- [ ] **Step 7: 既存テストの全件回帰確認**

Run: `npx vitest run`
Expected: 全件 PASS（index.ts は再エクポート追加のみで挙動不変）

- [ ] **Step 8: Commit**

```bash
git add src/server/tools/types.ts src/server/tools/tool-support.ts src/server/index.ts tests/shared/create-test-nexus-options.ts tests/unit/server/tools/tool-support.test.ts
git commit -m "refactor(server): ツールハンドラを SDK 中立の共有ビルダへ抽出"
```

---

### Task 7: v1 アダプタと `src/server/index.ts` のレジストリ移行

**Files:**
- Create: `src/server/tools/registry/adapters/v1-adapter.ts`
- Modify: `src/server/index.ts`（`createNexusServer` の登録をアダプタ経由に置換、`NexusServerOptions` を再エクポート化、不要 import 削除）
- Modify: `src/server/tools/get-context-schema.ts`（zod スキーマ廃止 → 型のみモジュール化）
- Test: `tests/unit/server/tools/registry/adapters/v1-adapter.test.ts`

**Interfaces:**
- Consumes: `TOOL_DEFINITIONS`（Task 5）、`buildToolHandlers` / `NexusServerOptions` / `ToolHandler`（Task 6）
- Produces:
  - `toZodV3Shape(schema: NeutralSchema): z.ZodRawShape`
  - `registerV1Tools(server: McpServer, handlers: Record<string, ToolHandler>): void`（v1 `McpServer` = `@modelcontextprotocol/sdk/server/mcp.js`）
  - `GetContextToolArgs`（zod 由来を廃止した手書きインターフェース）

- [ ] **Step 1: v1 アダプタを実装**

`src/server/tools/registry/adapters/v1-adapter.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { NeutralField, NeutralSchema } from '../schemas-neutral.js';
import { TOOL_DEFINITIONS } from '../definitions.js';
import type { ToolHandler } from '../../types.js';

/**
 * Compile a neutral field to zod v3. The optional `maximum` cap is a v2-only
 * input-validation rule (design §10.3) and is deliberately ignored here —
 * the v1 input contract is unchanged.
 */
const toZodV3Field = (field: NeutralField): z.ZodTypeAny => {
  switch (field.kind) {
    case 'string':
      return z.string();
    case 'integer':
      return z.number().int().positive();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'stringArray':
      return z.array(z.string());
    case 'enum':
      return z.enum(field.values);
  }
};

/** Compile a neutral schema to a zod v3 raw shape for McpServer.registerTool. */
export const toZodV3Shape = (schema: NeutralSchema): z.ZodRawShape => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema)) {
    let zodField = toZodV3Field(field);
    if (field.optional === true) {
      zodField = zodField.optional();
    }
    if ('default' in field && field.default !== undefined) {
      zodField = zodField.default(field.default);
    }
    if (field.description !== undefined) {
      zodField = zodField.describe(field.description);
    }
    shape[key] = zodField;
  }
  return shape;
};

/** Register all neutral tool definitions on a v1 McpServer. */
export const registerV1Tools = (
  server: McpServer,
  handlers: Record<string, ToolHandler>,
): void => {
  for (const definition of TOOL_DEFINITIONS) {
    const handler = handlers[definition.name];
    if (handler === undefined) {
      throw new Error(`missing handler for tool: ${definition.name}`);
    }
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: toZodV3Shape(definition.input),
      },
      handler,
    );
  }
};
```

- [ ] **Step 2: 失敗するパリティテストを書く**

`tests/unit/server/tools/registry/adapters/v1-adapter.test.ts`。期待値テーブルは移行前の `src/server/index.ts` 登録内容（name / description / required）のスナップショット:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { buildToolHandlers } from '../../../../../src/server/tools/tool-support.js';
import { registerV1Tools } from '../../../../../src/server/tools/registry/adapters/v1-adapter.js';
import { createTestNexusOptions } from '../../../../../shared/create-test-nexus-options.js';

const EXPECTED_TOOLS: ReadonlyArray<{ name: string; description: string; required: string[] }> = [
  {
    name: 'semantic_search',
    description: 'Vector-only semantic search; prefer hybrid_search for most tasks.',
    required: ['query'],
  },
  {
    name: 'grep_search',
    description: 'Exact string search for symbols, errors, or code fragments.',
    required: ['pattern'],
  },
  {
    name: 'hybrid_search',
    description: 'Semantic + grep hybrid search for vague or conceptual queries.',
    required: ['query'],
  },
  {
    name: 'get_context',
    description: 'Return a specific line range from a file; prefer partial reads.',
    required: ['filePath'],
  },
  {
    name: 'index_status',
    description: 'Check indexing progress and statistics before searching.',
    required: [],
  },
  {
    name: 'reindex',
    description: 'Manually rebuild the local search index.',
    required: [],
  },
];

describe('v1 adapter parity', () => {
  let client: Client | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
  });

  const connect = async (): Promise<Client> => {
    const { options } = await createTestNexusOptions();
    server = new McpServer(
      { name: 'nexus', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    registerV1Tools(server, buildToolHandlers(options));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'v1-parity-client', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  };

  it('lists the 6 tools with legacy names, descriptions and required params', async () => {
    const connected = await connect();
    const list = await connected.listTools();
    expect(list.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS.map((tool) => tool.name));
    for (const expected of EXPECTED_TOOLS) {
      const actual = list.tools.find((tool) => tool.name === expected.name);
      expect(actual?.description).toBe(expected.description);
      const required = (actual?.inputSchema.required ?? []) as string[];
      expect([...required].sort()).toEqual([...expected.required].sort());
    }
  });

  it('calls grep_search and returns the legacy structuredContent shape', async () => {
    const connected = await connect();
    const result = await connected.callTool({ name: 'grep_search', arguments: { pattern: 'authenticate' } });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { matches: Array<{ filePath: string }> };
    expect(structured.matches).toHaveLength(1);
    expect(structured.matches[0]?.filePath).toBe('src/auth.ts');
  });

  it('keeps the legacy error shape on the v1 path (no error.code)', async () => {
    const connected = await connect();
    const result = await connected.callTool({ name: 'get_context', arguments: { filePath: 'nope.ts' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: true });
    expect(result.structuredContent).not.toHaveProperty('code');
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run tests/unit/server/tools/registry/adapters/v1-adapter.test.ts`
Expected: FAIL（`v1-adapter.js` のモジュール解決エラー — Step 1 を先に実施済みの場合は PASS してよい。その場合は index.ts 未移行のまま Step 4 へ進む）

- [ ] **Step 4: `get-context-schema.ts` を型のみモジュールに書き換え**

`src/server/tools/get-context-schema.ts` を全文置換:

```typescript
/**
 * get_context tool arguments. Previously derived from a zod v3 schema; now
 * authored directly and paired with the SDK-neutral definition in
 * ./registry/definitions.ts (design doc §7.1). The v1/v2 adapters apply the
 * `mode` default ("eager") at SDK validation time, so handlers always see it.
 */
export interface GetContextToolArgs {
  filePath: string;
  /**
   * @deprecated reserved for future use
   */
  symbolName?: string;
  startLine?: number;
  endLine?: number;
  mode: 'eager' | 'deferred';
}
```

- [ ] **Step 5: `src/server/index.ts` をアダプタ経由に書き換え**

(a) `createNexusServer`（111-321 行付近）の 6 つの `server.registerTool(...)` ブロックをすべて削除し、以下に置き換える。`McpServer` のコンストラクタ引数（name/version/capabilities/instructions）は **一字一句変更しない**:

```typescript
  registerV1Tools(server, buildToolHandlers(options, awaitInitialize));
  return server;
};
```

(b) `NexusServerOptions` のローカル定義（Task 6 で `types.ts` にコピー済みのインターフェース）を削除し、以下の再エクポートに置き換える:

```typescript
export type { NexusServerOptions } from './tools/types.js';
```

(c) 不要になった import（`z`、`getContextInputSchema`、`withToolMetrics`、各 `execute*`、ツール引数型）を削除する。`tsc` と eslint の未使用検出に従って漏れなく消す。`NexusRuntimeOptions`・`buildNexusRuntime`・`initializeNexusRuntime`・`resolveProjectId` 等の残りのコードには触れない。

- [ ] **Step 6: パリティテストと既存テストの全件回帰確認**

Run: `npx vitest run tests/unit/server/tools/registry/adapters/v1-adapter.test.ts && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: パリティテスト PASS（3/3）、既存テスト **1 件も変更せず** 全件 PASS、tsc / lint exit 0

- [ ] **Step 7: Commit**

```bash
git add src/server/tools/registry/adapters/v1-adapter.ts src/server/index.ts src/server/tools/get-context-schema.ts tests/unit/server/tools/registry/adapters/v1-adapter.test.ts
git commit -m "refactor(server): v1 ツール登録を中立レジストリのアダプタへ移行"
```

---

### Task 8: v2 アダプタ（zod v4 変換 + 上限クランプ + error.code 付与）

**Files:**
- Create: `src/server/tools/registry/adapters/v2-adapter.ts`
- Test: `tests/unit/server/tools/registry/adapters/v2-adapter.test.ts`

**Interfaces:**
- Consumes: `TOOL_DEFINITIONS`（Task 5）、`buildToolHandlers` 系の型（Task 6）、`classifyErrorMessage`（Task 2）
- Produces:
  - `interface V2ToolLimits { topK: number; maxResults: number }`
  - `toZodV4Object(schema: NeutralSchema, limits?: V2ToolLimits)` — zod v4 object スキーマを返す
  - `registerV2Tools(server: McpServer, handlers: Record<string, ToolHandler>, limits?: V2ToolLimits): void`（v2 `McpServer` = `@modelcontextprotocol/server`）
  - `withErrorCode(result: NexusToolCallResult): NexusToolCallResult`

- [ ] **Step 1: v2 アダプタを実装（前半: リミット解決とフィールド変換）**

`src/server/tools/registry/adapters/v2-adapter.ts`:

```typescript
import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';

import { classifyErrorMessage } from '../../errors.js';
import { TOOL_DEFINITIONS } from '../definitions.js';
import type { NeutralField, NeutralSchema } from '../schemas-neutral.js';
import type { NexusToolCallResult, ToolHandler } from '../../types.js';

/** Configurable input-validation caps for the v2 path (design §10.3). */
export interface V2ToolLimits {
  topK: number;
  maxResults: number;
}

const DEFAULT_V2_TOOL_LIMITS: V2ToolLimits = { topK: 100, maxResults: 1000 };

/** Per-field cap resolution: only topK / maxResults are config-overridable. */
const limitFor = (fieldName: string, declaredMaximum: number, limits: V2ToolLimits): number => {
  if (fieldName === 'topK') return limits.topK;
  if (fieldName === 'maxResults') return limits.maxResults;
  return declaredMaximum;
};

const toZodV4Field = (name: string, field: NeutralField, limits: V2ToolLimits): z.ZodTypeAny => {
  switch (field.kind) {
    case 'string':
      return z.string();
    case 'integer': {
      let intField = z.number().int().positive();
      if (field.maximum !== undefined) {
        intField = intField.max(limitFor(name, field.maximum, limits));
      }
      return intField;
    }
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'stringArray':
      return z.array(z.string());
    case 'enum':
      return z.enum(field.values);
  }
};
```


(a) 続けて `toZodV4Object` / `withErrorCode` / `registerV2Tools` を同ファイルに追記:

```typescript
/** Compile a neutral schema to a zod v4 object schema for the v2 registerTool. */
export const toZodV4Object = (
  schema: NeutralSchema,
  limits: V2ToolLimits = DEFAULT_V2_TOOL_LIMITS,
) => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema)) {
    let zodField = toZodV4Field(key, field, limits);
    if (field.optional === true) {
      zodField = zodField.optional();
    }
    if ('default' in field && field.default !== undefined) {
      zodField = zodField.default(field.default);
    }
    if (field.description !== undefined) {
      zodField = zodField.describe(field.description);
    }
    shape[key] = zodField;
  }
  return z.object(shape);
};

/**
 * Attach structuredContent.error.code to v2 error results (design §9.3).
 * Non-error results and unclassified errors pass through unchanged, so the
 * legacy fields (error: true, message) are never removed or renamed.
 */
export const withErrorCode = (result: NexusToolCallResult): NexusToolCallResult => {
  if (result.isError !== true || result.structuredContent === undefined) {
    return result;
  }
  const message = result.structuredContent.message;
  const code = typeof message === 'string' ? classifyErrorMessage(message) : undefined;
  if (code === undefined) {
    return result;
  }
  return { ...result, structuredContent: { ...result.structuredContent, code } };
};

/** Register all neutral tool definitions on a v2 McpServer. */
export const registerV2Tools = (
  server: McpServer,
  handlers: Record<string, ToolHandler>,
  limits: V2ToolLimits = DEFAULT_V2_TOOL_LIMITS,
): void => {
  for (const definition of TOOL_DEFINITIONS) {
    const handler = handlers[definition.name];
    if (handler === undefined) {
      throw new Error(`missing handler for tool: ${definition.name}`);
    }
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: toZodV4Object(definition.input, limits),
      },
      async (args, extra) => withErrorCode(await handler(args, { signal: extra?.signal })),
    );
  }
};
```

注意: v2 の `registerTool` コールバック第 2 引数（extra）のプロパティ名は SDK v2.0.0 の `ToolCallback` 型定義に従う。`tsc` が別名を指摘した場合はそちらに合わせる。


- [ ] **Step 2: 失敗するスキーマパリティテストを書く**

`tests/unit/server/tools/registry/adapters/v2-adapter.test.ts`。zod v3 / v4 はどちらもルートの `zod@3.25.x` から import できる（`zod/v4` サブパス）:

```typescript
import { describe, expect, it } from 'vitest';
import { z as z3 } from 'zod';
import { z as z4 } from 'zod/v4';

import { TOOL_DEFINITIONS } from '../../../../../src/server/tools/registry/definitions.js';
import { toZodV3Shape } from '../../../../../src/server/tools/registry/adapters/v1-adapter.js';
import { toZodV4Object, withErrorCode } from '../../../../../src/server/tools/registry/adapters/v2-adapter.js';

describe('v1/v2 schema parity', () => {
  const baselineValid: Record<string, Record<string, unknown>> = {
    semantic_search: { query: 'auth', topK: 5 },
    grep_search: { pattern: 'foo', maxResults: 10, caseSensitive: true },
    hybrid_search: { query: 'auth', topK: 5, contextLines: 3 },
    get_context: { filePath: 'src/a.ts', startLine: 1, endLine: 5 },
    index_status: {},
    reindex: { fullRebuild: true },
  };

  it('accepts the same valid inputs in v3 and v4', () => {
    for (const definition of TOOL_DEFINITIONS) {
      const v3 = z3.object(toZodV3Shape(definition.input));
      const v4 = toZodV4Object(definition.input);
      const args = baselineValid[definition.name];
      expect(v3.safeParse(args).success, `${definition.name} v3`).toBe(true);
      expect(v4.safeParse(args).success, `${definition.name} v4`).toBe(true);
    }
  });

  it('rejects type-violating inputs in both v3 and v4', () => {
    const invalid: Record<string, Record<string, unknown>> = {
      semantic_search: { topK: 5 },
      grep_search: { maxResults: 'ten' },
      hybrid_search: { query: 'auth', topK: -1 },
      get_context: { filePath: 'src/a.ts', mode: 'lazy' },
      index_status: {},
      reindex: { fullRebuild: 'yes' },
    };
    for (const definition of TOOL_DEFINITIONS) {
      const v3 = z3.object(toZodV3Shape(definition.input));
      const v4 = toZodV4Object(definition.input);
      const args = invalid[definition.name];
      expect(v3.safeParse(args).success, `${definition.name} v3`).toBe(false);
      expect(v4.safeParse(args).success, `${definition.name} v4`).toBe(false);
    }
  });

  it('rejects over-limit integers only in v4 (design §10.3)', () => {
    const hybrid = TOOL_DEFINITIONS.find((d) => d.name === 'hybrid_search');
    const grep = TOOL_DEFINITIONS.find((d) => d.name === 'grep_search');
    if (hybrid === undefined || grep === undefined) {
      throw new Error('expected definitions are missing');
    }

    const hybridV3 = z3.object(toZodV3Shape(hybrid.input));
    const hybridV4 = toZodV4Object(hybrid.input);
    expect(hybridV3.safeParse({ query: 'auth', topK: 101 }).success).toBe(true);
    expect(hybridV4.safeParse({ query: 'auth', topK: 101 }).success).toBe(false);
    expect(hybridV4.safeParse({ query: 'auth', contextLines: 21 }).success).toBe(false);

    const grepV3 = z3.object(toZodV3Shape(grep.input));
    const grepV4 = toZodV4Object(grep.input);
    expect(grepV3.safeParse({ pattern: 'x', maxResults: 1001 }).success).toBe(true);
    expect(grepV4.safeParse({ pattern: 'x', maxResults: 1001 }).success).toBe(false);
  });

  it('honours config-driven limit overrides', () => {
    const hybrid = TOOL_DEFINITIONS.find((d) => d.name === 'hybrid_search');
    if (hybrid === undefined) {
      throw new Error('hybrid_search definition is missing');
    }
    const v4 = toZodV4Object(hybrid.input, { topK: 25, maxResults: 100 });
    expect(v4.safeParse({ query: 'auth', topK: 25 }).success).toBe(true);
    expect(v4.safeParse({ query: 'auth', topK: 26 }).success).toBe(false);
  });
});
```


(a) 同ファイルに `withErrorCode` のテストを追記:

```typescript
describe('withErrorCode', () => {
  it('attaches NEXUS_CONTENT_NOT_FOUND to ENOENT-style error results', () => {
    const legacy = {
      content: [{ type: 'text' as const, text: "Error: ENOENT: no such file or directory, open 'x.ts'" }],
      isError: true,
      structuredContent: { error: true, message: "ENOENT: no such file or directory, open 'x.ts'" },
    };
    const result = withErrorCode(legacy);
    expect(result.structuredContent).toEqual({
      error: true,
      message: "ENOENT: no such file or directory, open 'x.ts'",
      code: 'NEXUS_CONTENT_NOT_FOUND',
    });
  });

  it('passes non-error results through by identity', () => {
    const ok = {
      content: [{ type: 'text' as const, text: '{}' }],
      structuredContent: { results: [] },
    };
    expect(withErrorCode(ok)).toBe(ok);
  });

  it('passes unclassified errors through unchanged (legacy shape preserved)', () => {
    const legacy = {
      content: [{ type: 'text' as const, text: 'Error: boom' }],
      isError: true,
      structuredContent: { error: true, message: 'boom' },
    };
    expect(withErrorCode(legacy)).toBe(legacy);
  });
});
```

(b) 同ファイルに v2 in-memory 接続テストを追記（v2 `McpServer` と v2 `Client` を `InMemoryTransport.createLinkedPair()` で接続）:

```typescript
describe('v2 adapter over InMemoryTransport', () => {
  it('lists the 6 tools and calls grep_search', async () => {
    const { McpServer } = await import('@modelcontextprotocol/server');
    const { InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const { buildToolHandlers } = await import('../../../../../src/server/tools/tool-support.js');
    const { registerV2Tools } = await import('../../../../../src/server/tools/registry/adapters/v2-adapter.js');
    const { createTestNexusOptions } = await import('../../../../../shared/create-test-nexus-options.js');

    const { options } = await createTestNexusOptions();
    const server = new McpServer({ name: 'nexus', version: '0.1.0' });
    registerV2Tools(server, buildToolHandlers(options));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'v2-parity-client', version: '0.0.1' });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual([
        'semantic_search',
        'grep_search',
        'hybrid_search',
        'get_context',
        'index_status',
        'reindex',
      ]);
      const result = await client.callTool({ name: 'grep_search', arguments: { pattern: 'authenticate' } });
      expect(result.isError).toBeUndefined();
      const structured = result.structuredContent as { matches: Array<{ filePath: string }> };
      expect(structured.matches).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
```

注意: v2 `Client` / `McpServer` のコンストラクタ引数や `callTool` の戻り値型はインストール済み SDK v2.0.0 の `.d.mts` に従う。`tsc` の指摘に従って調整するが、**テストの期待値（6 ツール名・結果件数）は変えない**。

- [ ] **Step 3: テストが失敗することを確認 → 実装後 PASS**

Run: `npx vitest run tests/unit/server/tools/registry/adapters/v2-adapter.test.ts`
Expected: Step 1 実装前は FAIL（モジュール解決エラー）、実装後は PASS（6/6）

- [ ] **Step 4: 静的検査と全件回帰**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: すべて exit 0 / 全件 PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/registry/adapters/v2-adapter.ts tests/unit/server/tools/registry/adapters/v2-adapter.test.ts
git commit -m "feat(server): SDK v2 ツールアダプタを追加"
```

---

### Task 9: LocalContentStore 新設と get_context / hybrid_search の切替

**Files:**
- Create: `src/storage/local/local-content-store.ts`
- Modify: `src/server/tools/types.ts`（`NexusServerOptions.contentStore?: IContentStore` 追加）
- Modify: `src/server/index.ts`（`NexusRuntimeOptions.contentStore?: IContentStore` 追加）
- Modify: `src/server/tools/tool-support.ts`（`createContentReader` 追加、get_context / hybrid_search の読み出し差し替え）
- Modify: `src/server/factory.ts`（sanitizer ホイスト、ContentStore 生成・注入）
- Test: `tests/unit/storage/local-content-store.test.ts`（新設）、`tests/unit/server/tools/tool-support.test.ts`（追記）

**Interfaces:**
- Consumes: `IContentStore` / `IContentStoreFactory`（既存 `src/storage/interfaces/content-store.ts`）、`PathSanitizer`
- Produces:
  - `LocalContentStore implements IContentStore`（readRange のみ本実装。put/delete は Phase 4 まで未実装で throw、get/existsは空読み — 設計書 §7.3）
  - `LocalContentStoreFactory implements IContentStoreFactory`（`new LocalContentStoreFactory({ projectRoot, sanitize })`、`getStore(workspaceId, revisionId)` は非空検証のうえ共有インスタンスを返す）
  - `createContentReader(contentStore: IContentStore | undefined, fallback: (filePath: string) => Promise<string>): (filePath: string) => Promise<string>`（tool-support.ts）

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/storage/local-content-store.test.ts`:

```typescript
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import { LocalContentStoreFactory } from '../../../src/storage/local/local-content-store.js';

describe('LocalContentStore', () => {
  let root: string;
  let factory: LocalContentStoreFactory;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nexus-content-store-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'l1\nl2\nl3\n');
    const sanitizer = await PathSanitizer.create(root);
    factory = new LocalContentStoreFactory({
      projectRoot: root,
      sanitize: (filePath) => sanitizer.sanitize(filePath),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('readRange returns the requested inclusive line range', async () => {
    const store = factory.getStore('ws', 'rev');
    await expect(store.readRange('src/a.ts', 2, 3)).resolves.toBe('l2\nl3');
  });

  it('readRange clamps out-of-range bounds to file boundaries', async () => {
    const store = factory.getStore('ws', 'rev');
    await expect(store.readRange('src/a.ts', 1, Number.MAX_SAFE_INTEGER)).resolves.toBe('l1\nl2\nl3\n');
  });

  it('readRange throws an Invalid line range error when start exceeds end', async () => {
    const store = factory.getStore('ws', 'rev');
    await expect(store.readRange('src/a.ts', 3, 2)).rejects.toThrow(/^Invalid line range:/);
  });

  it('readRange rejects paths outside the project root', async () => {
    const store = factory.getStore('ws', 'rev');
    await expect(store.readRange('../outside.ts', 1, 1)).rejects.toThrow();
  });

  it('hash-based methods are Phase 4 scope: get/exists empty, put/delete throw', async () => {
    const store = factory.getStore('ws', 'rev');
    await expect(store.get('abc')).resolves.toBeNull();
    await expect(store.exists('abc')).resolves.toBe(false);
    await expect(store.put('abc', new Uint8Array())).rejects.toThrow(/not implemented/);
    await expect(store.delete('abc')).rejects.toThrow(/not implemented/);
  });

  it('factory validates non-empty scope identifiers', () => {
    expect(() => factory.getStore('', 'rev')).toThrow(/workspaceId/);
    expect(() => factory.getStore('ws', '')).toThrow(/revisionId/);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/unit/storage/local-content-store.test.ts`
Expected: FAIL（`local-content-store.js` のモジュール解決エラー）


- [ ] **Step 3: `LocalContentStore` を実装**

`src/storage/local/local-content-store.ts`。行範囲のクランプ規則は `src/server/tools/context-helpers.ts` の `resolveLineRange` と同一（両端を [1, totalLines] にクランプ後、start > end なら throw）。storage 層から server 層を import しないよう、クランプはインライン実装する:

```typescript
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { IContentStore, IContentStoreFactory } from '../interfaces/content-store.js';

/** Dependencies for the local filesystem-backed ContentStore. */
export interface LocalContentStoreDeps {
  projectRoot: string;
  /** Path validation hook (typically PathSanitizer.sanitize, bound). */
  sanitize: (filePath: string) => Promise<string>;
}

const clampLine = (line: number, totalLines: number): number =>
  Math.max(1, Math.min(line, totalLines));

/**
 * Filesystem-backed ContentStore for Phase 2 (design doc §7.3).
 *
 * readRange sanitizes the path, reads the file from the local filesystem,
 * and extracts the requested inclusive line range. The hash-addressed blob
 * methods are Phase 4 (Sync Agent) scope: get/exists report empty and
 * put/delete throw — local search is read-only.
 *
 * Workspace/revision binding: Phase 2 has exactly one local workspace, so
 * getStore validates the identifiers but returns a shared instance. The
 * (workspaceId, revisionId) binding becomes meaningful in Phase 4+.
 */
export class LocalContentStore implements IContentStore {
  constructor(private readonly deps: LocalContentStoreDeps) {}

  async put(_contentHash: string, _content: Uint8Array): Promise<void> {
    throw new Error('LocalContentStore.put is not implemented (Phase 4 scope)');
  }

  async get(_contentHash: string): Promise<Uint8Array | null> {
    return null;
  }

  async delete(_contentHash: string): Promise<void> {
    throw new Error('LocalContentStore.delete is not implemented (Phase 4 scope)');
  }

  async exists(_contentHash: string): Promise<boolean> {
    return false;
  }

  async readRange(path: string, startLine: number, endLine: number): Promise<string> {
    const sanitizedPath = await this.deps.sanitize(path);
    const content = await readFile(resolve(this.deps.projectRoot, sanitizedPath), 'utf8');
    const lines = content.split('\n');
    const totalLines = lines.length;
    const clampedStart = clampLine(startLine, totalLines);
    const clampedEnd = clampLine(endLine, totalLines);
    if (clampedStart > clampedEnd) {
      throw new Error(
        `Invalid line range: startLine (${clampedStart}) is greater than endLine (${clampedEnd})`,
      );
    }
    return lines.slice(clampedStart - 1, clampedEnd).join('\n');
  }
}

/** Factory for workspace/revision-scoped LocalContentStore instances. */
export class LocalContentStoreFactory implements IContentStoreFactory {
  private readonly store: LocalContentStore;

  constructor(deps: LocalContentStoreDeps) {
    this.store = new LocalContentStore(deps);
  }

  getStore(workspaceId: string, revisionId: string): IContentStore {
    if (workspaceId.trim() === '') {
      throw new Error('workspaceId must be a non-empty string');
    }
    if (revisionId.trim() === '') {
      throw new Error('revisionId must be a non-empty string');
    }
    // Phase 2: a single local workspace exists, so one shared instance suffices.
    return this.store;
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run tests/unit/storage/local-content-store.test.ts`
Expected: PASS（6/6）


- [ ] **Step 5: `createContentReader` を tool-support.ts に追加し、get_context / hybrid_search に配線**

(a) `src/server/tools/tool-support.ts` に追記:

```typescript
import type { IContentStore } from '../../storage/interfaces/content-store.js';

/**
 * Read file content through the ContentStore when available (design §7.3),
 * falling back to the direct filesystem reader on failure. readRange clamps
 * the end line to EOF, so (1, MAX_SAFE_INTEGER) yields the full file — the
 * same content loadFileContent returns.
 */
export const createContentReader = (
  contentStore: IContentStore | undefined,
  fallback: (filePath: string) => Promise<string>,
): ((filePath: string) => Promise<string>) => {
  if (contentStore === undefined) {
    return fallback;
  }
  return async (filePath) => {
    try {
      return await contentStore.readRange(filePath, 1, Number.MAX_SAFE_INTEGER);
    } catch (error) {
      console.warn('[Nexus] ContentStore readRange failed; falling back to filesystem read:', error);
      return fallback(filePath);
    }
  };
};
```

(b) `buildToolHandlers` の先頭に `const readContent = createContentReader(options.contentStore, options.loadFileContent);` を追加し、get_context と hybrid_search のハンドラ内の `options.loadFileContent` 参照を `readContent` に置き換える（2 箇所）。他のハンドラは触れない。

(c) `src/server/tools/types.ts` の `NexusServerOptions` に `contentStore?: IContentStore` を追加（`import type { IContentStore } from '../../storage/interfaces/content-store.js';` を併記）。`src/server/index.ts` の `NexusRuntimeOptions` にも同じフィールドを追加する（runtime は options をそのまま `createNexusServer` に流すため、両方に必要）。

- [ ] **Step 6: リーダーのフォールバックテストを追記**

`tests/unit/server/tools/tool-support.test.ts` の末尾に追記:

```typescript
describe('createContentReader (ContentStore wiring)', () => {
  const stubStore = (overrides: Partial<IContentStore>): IContentStore => ({
    put: async () => undefined,
    get: async () => null,
    delete: async () => undefined,
    exists: async () => false,
    readRange: async () => 'FROM_STORE',
    ...overrides,
  });

  it('reads through the ContentStore when one is provided', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers({
      ...options,
      contentStore: stubStore({}),
      loadFileContent: async () => {
        throw new Error('filesystem reader must not be called');
      },
    });
    const result = await handlers.get_context({ filePath: 'src/auth.ts' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ filePath: 'src/auth.ts', content: 'FROM_STORE' });
  });

  it('falls back to loadFileContent when readRange throws', async () => {
    const { options } = await createTestNexusOptions();
    const failing = stubStore({
      readRange: async () => {
        throw new Error('store unavailable');
      },
    });
    const handlers = buildToolHandlers({ ...options, contentStore: failing });
    const result = await handlers.get_context({ filePath: 'src/auth.ts' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      filePath: 'src/auth.ts',
      content: 'export function authenticate() {}\n',
    });
  });
});
```

（ファイル先頭に `import type { IContentStore } from '../../../../src/storage/interfaces/content-store.js';` を追加。）

- [ ] **Step 7: factory.ts で ContentStore を生成・注入**

`src/server/factory.ts` の `createRuntime` を編集:

(a) `buildNexusRuntime` 呼び出しより前に sanitizer 生成をホイストし、ContentStore を生成:

```typescript
    const sanitizer = await PathSanitizer.create(projectRoot);
    // Phase 2 single-workspace mapping (design §11); Phase 4+ replaces the literal revision.
    const workspaceId = config.projectName ?? projectRoot.split(/[\\/]/).findLast(Boolean) ?? 'unknown';
    const contentStoreFactory = new LocalContentStoreFactory({
      projectRoot,
      sanitize: (filePath) => sanitizer.sanitize(filePath),
    });
    const contentStore = contentStoreFactory.getStore(workspaceId, 'local');
```

(b) `buildNexusRuntime({...})` の引数オブジェクトで `sanitizer: await PathSanitizer.create(projectRoot),` を `sanitizer,` に置き換え、`contentStore,` を 1 行追加する。

(c) 先頭の import に `import { LocalContentStoreFactory } from '../storage/local/local-content-store.js';` を追加。

- [ ] **Step 8: テストと静的検査、全件回帰**

Run: `npx vitest run tests/unit/storage/local-content-store.test.ts tests/unit/server/tools/tool-support.test.ts && npx tsc --noEmit && npm run lint && npx vitest run`
Expected: 個別テスト PASS、tsc / lint exit 0、既存を含む全件 PASS

- [ ] **Step 9: Commit**

```bash
git add src/storage/local/local-content-store.ts src/server/tools/types.ts src/server/index.ts src/server/tools/tool-support.ts src/server/factory.ts tests/unit/storage/local-content-store.test.ts tests/unit/server/tools/tool-support.test.ts
git commit -m "feat(storage): LocalContentStore を新設し get_context 系の読み出しを切り替え"
```

---

### Task 10: HTTP v2 の Origin / Host 検証

**Files:**
- Create: `src/server/http-v2/net.ts`
- Create: `src/server/http-v2/headers.ts`
- Test: `tests/unit/server/http-v2/headers.test.ts`

**Interfaces:**
- Consumes: `isLoopbackHost`（Task 1 の `src/config/index.ts`）
- Produces:
  - `isAllowedHostHeader(hostHeader: string | undefined): boolean`（net.ts）
  - `isAllowedOriginHeader(originHeader: string | undefined): boolean`（net.ts）
  - `type HeaderVerdict = { ok: true } | { ok: false; reason: string }`（headers.ts）
  - `validateRequestHeaders(host: string | undefined, origin: string | undefined): HeaderVerdict`（headers.ts）
  - `applySecurityHeaders(res: ServerResponse): void`（headers.ts）

設計書 §5-5 により Origin/Host 検証はアプリ側の責務。SDK v2 は検証ヘルパを export しているが、依存方向ルール（§7.5: `@modelcontextprotocol/server` の import は server-factory.ts / v2-adapter.ts のみ）に従い、ここでは SDK に依存しない自前実装とする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/server/http-v2/headers.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { isAllowedHostHeader, isAllowedOriginHeader } from '../../../../src/server/http-v2/net.js';
import { validateRequestHeaders } from '../../../../src/server/http-v2/headers.js';

describe('isAllowedHostHeader', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.0.1:9200', true],
    ['localhost', true],
    ['localhost:9200', true],
    ['[::1]:9200', true],
    ['127.0.1.5:1', true],
    ['0.0.0.0', false],
    ['0.0.0.0:9200', false],
    ['example.com', false],
    ['169.254.169.254', false],
    ['[::]:9200', false],
    [undefined, false],
  ])('host %p → %p', (host, expected) => {
    expect(isAllowedHostHeader(host)).toBe(expected);
  });
});

describe('isAllowedOriginHeader', () => {
  it.each([
    [undefined, true],
    ['http://127.0.0.1:9200', true],
    ['http://localhost:3000', true],
    ['http://[::1]:9200', true],
    ['https://evil.example', false],
    ['http://0.0.0.0:9200', false],
    ['not a url', false],
  ])('origin %p → %p', (origin, expected) => {
    expect(isAllowedOriginHeader(origin)).toBe(expected);
  });
});

describe('validateRequestHeaders', () => {
  it('accepts loopback host with loopback origin', () => {
    expect(validateRequestHeaders('127.0.0.1:9200', 'http://127.0.0.1:9200')).toEqual({ ok: true });
  });

  it('rejects a non-loopback host', () => {
    const verdict = validateRequestHeaders('example.com', undefined);
    expect(verdict.ok).toBe(false);
  });

  it('rejects a non-loopback origin (DNS rebinding guard)', () => {
    const verdict = validateRequestHeaders('127.0.0.1:9200', 'https://evil.example');
    expect(verdict.ok).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/unit/server/http-v2/headers.test.ts`
Expected: FAIL（`net.js` / `headers.js` のモジュール解決エラー）

- [ ] **Step 3: `net.ts` を実装**

`src/server/http-v2/net.ts`:

```typescript
import { isLoopbackHost } from '../../config/index.js';

/** Extract the host part from a Host header value, dropping any port. */
const extractHost = (hostHeader: string): string => {
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  // Multiple colons without brackets: a bare IPv6 literal (no port).
  if (colonCount > 1) {
    return trimmed;
  }
  const colonIndex = trimmed.indexOf(':');
  return colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex);
};

/** A Host header is required and must name a loopback interface (fail-closed). */
export const isAllowedHostHeader = (hostHeader: string | undefined): boolean => {
  if (hostHeader === undefined) {
    return false;
  }
  return isLoopbackHost(extractHost(hostHeader));
};

/**
 * An Origin header is optional (non-browser clients omit it), but when
 * present it must name a loopback origin — this is the DNS-rebinding guard
 * (design doc §5-5).
 */
export const isAllowedOriginHeader = (originHeader: string | undefined): boolean => {
  if (originHeader === undefined || originHeader.trim() === '') {
    return true;
  }
  try {
    return isLoopbackHost(new URL(originHeader).hostname);
  } catch {
    return false;
  }
};
```

- [ ] **Step 4: `headers.ts` を実装**

`src/server/http-v2/headers.ts`:

```typescript
import type { ServerResponse } from 'node:http';

import { isAllowedHostHeader, isAllowedOriginHeader } from './net.js';

export type HeaderVerdict = { ok: true } | { ok: false; reason: string };

/** Validate the HTTP-level Host/Origin headers for the local-only v2 endpoint. */
export const validateRequestHeaders = (
  host: string | undefined,
  origin: string | undefined,
): HeaderVerdict => {
  if (!isAllowedHostHeader(host)) {
    return { ok: false, reason: 'Host header does not identify a loopback interface' };
  }
  if (!isAllowedOriginHeader(origin)) {
    return { ok: false, reason: 'Origin header does not identify a loopback interface' };
  }
  return { ok: true };
};

/** Baseline security headers for every response from the v2 endpoint. */
export const applySecurityHeaders = (res: ServerResponse): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
};
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run tests/unit/server/http-v2/headers.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS、tsc / lint exit 0

- [ ] **Step 6: Commit**

```bash
git add src/server/http-v2/net.ts src/server/http-v2/headers.ts tests/unit/server/http-v2/headers.test.ts
git commit -m "feat(server): HTTP v2 の Origin/Host 検証を追加"
```

---

### Task 11: v2 サーバーファクトリ（`createMcpHandler` ベース）

**Files:**
- Create: `src/server/http-v2/server-factory.ts`
- Test: `tests/unit/server/http-v2/server-factory.test.ts`

**Interfaces:**
- Consumes: `createMcpHandler` / `McpServer`（`@modelcontextprotocol/server` v2）、`registerV2Tools`（Task 8）、`buildToolHandlers`（Task 6）
- Produces:
  - `interface V2ServerFactoryDeps { options: NexusServerOptions; awaitInitialize: () => Promise<void>; limits: V2ToolLimits; serverInfo?: { name: string; version: string } }`
  - `createV2McpHandler(deps: V2ServerFactoryDeps): McpHttpHandler`（`.fetch(request: Request): Promise<Response>` を持つ web-standard ハンドラ）

- [ ] **Step 1: `server-factory.ts` を実装**

`src/server/http-v2/server-factory.ts`:

```typescript
import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';

import { TOOL_DEFINITIONS } from '../tools/registry/definitions.js';
import { registerV2Tools, type V2ToolLimits } from '../tools/registry/adapters/v2-adapter.js';
import { buildToolHandlers } from '../tools/tool-support.js';
import type { NexusServerOptions } from '../tools/types.js';

export interface V2ServerFactoryDeps {
  options: NexusServerOptions;
  awaitInitialize: () => Promise<void>;
  limits: V2ToolLimits;
  serverInfo?: { name: string; version: string };
}

const DEFAULT_SERVER_INFO = { name: 'nexus', version: '0.1.0' } as const;

/**
 * Build the MCP 2026-07-28 HTTP handler (design doc §7.2 / §8.1).
 *
 * createMcpHandler constructs a fresh McpServer per request; the heavy
 * runtime services (SQLite / LanceDB / watcher / embedding) live in
 * deps.options and are shared through the factory closure — never rebuilt
 * per connection. legacy: 'reject' confines the endpoint to the 2026-07-28
 * era, so no Mcp-Session-Id and no session map exist on this path.
 */
export const createV2McpHandler = (deps: V2ServerFactoryDeps): McpHttpHandler =>
  createMcpHandler(
    () => {
      const server = new McpServer(deps.serverInfo ?? DEFAULT_SERVER_INFO, {
        capabilities: { tools: { listChanged: true } },
        instructions: 'Nexus MCP server for local code search and indexing.',
      });
      registerV2Tools(server, buildToolHandlers(deps.options, deps.awaitInitialize), deps.limits);
      return server;
    },
    { legacy: 'reject' },
  );
```

注意: SDK v2.0.0 の `McpServer` コンストラクタは `constructor(serverInfo: Implementation, options?: ServerOptions)`（インストール済みパッケージの `.d.mts` で確認済み）。`ServerOptions` に `instructions` / `capabilities.tools.listChanged` が存在しない場合は `tsc` が指摘する — その場合は `instructions` のみ外し（capabilities は設計書 §12.1 のレスポンス例と一致させるため残す）、コミットメッセージに理由を記録する。

- [ ] **Step 2: 失敗するテストを書く**

`tests/unit/server/http-v2/server-factory.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { createV2McpHandler } from '../../../../src/server/http-v2/server-factory.js';
import { createTestNexusOptions } from '../../../shared/create-test-nexus-options.js';

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2026-07-28',
} as const;

const post = (body: unknown, headers: Record<string, string> = MCP_HEADERS): Request =>
  new Request('http://127.0.0.1:9200/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

/** Read a JSON-RPC result from a plain-JSON or SSE-framed response body. */
const readJsonRpc = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text();
  const dataLines = text.split('\n').filter((line) => line.startsWith('data:'));
  const payload = dataLines.length > 0 ? (dataLines[dataLines.length - 1] ?? '').slice(5).trim() : text;
  return JSON.parse(payload) as Record<string, unknown>;
};

const createHandler = async () => {
  const { options } = await createTestNexusOptions();
  return createV2McpHandler({
    options,
    awaitInitialize: async () => {},
    limits: { topK: 100, maxResults: 1000 },
  });
};

describe('createV2McpHandler', () => {
  it('lists the 6 tools without a session header', async () => {
    const handler = await createHandler();
    const response = await handler.fetch(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = await readJsonRpc(response);
    const result = body.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'semantic_search',
      'grep_search',
      'hybrid_search',
      'get_context',
      'index_status',
      'reindex',
    ]);
  });

  it('answers server/discover with the nexus serverInfo meta (design §12.1)', async () => {
    const handler = await createHandler();
    const response = await handler.fetch(
      post({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
    );
    expect(response.status).toBe(200);
    const body = await readJsonRpc(response);
    const result = body.result as { _meta?: Record<string, { name?: string }> };
    expect(result._meta?.['io.modelcontextprotocol/serverInfo']?.name).toBe('nexus');
  });

  it('calls grep_search end-to-end through the stateless handler', async () => {
    const handler = await createHandler();
    const response = await handler.fetch(
      post({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'grep_search', arguments: { pattern: 'authenticate' } },
      }),
    );
    expect(response.status).toBe(200);
    const body = await readJsonRpc(response);
    const result = body.result as { structuredContent?: { matches: unknown[] } };
    expect(result.structuredContent?.matches).toHaveLength(1);
  });

  it('rejects 2025-era requests (legacy: reject)', async () => {
    const handler = await createHandler();
    const response = await handler.fetch(
      post(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { ...MCP_HEADERS, 'mcp-protocol-version': '2025-03-26' },
      ),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
```

- [ ] **Step 3: テストを実行して確認**

Run: `npx vitest run tests/unit/server/http-v2/server-factory.test.ts`
Expected: Step 1 実装前は FAIL（モジュール解決エラー）、実装後は PASS（4/4）。SDK v2 のステータスコード・ヘッダ挙動が想定と異なる場合は **SDK 側の実挙動を `.d.mts` / 実レスポンスで確認してから** アサーションを実挙動に合わせ、設計書との差分をコミットメッセージに記録する（闇雑に期待値を緩めない）。

- [ ] **Step 4: 静的検査**

Run: `npx tsc --noEmit && npm run lint`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/server/http-v2/server-factory.ts tests/unit/server/http-v2/server-factory.test.ts
git commit -m "feat(server): MCP v2 ハンドラファクトリを追加"
```

---

### Task 12: ルーティング / transport / entry（HTTP サーバー統合）

**Files:**
- Create: `src/server/http-v2/transport.ts`
- Create: `src/server/http-v2/routes.ts`
- Create: `src/server/http-v2/entry.ts`
- Test: `tests/unit/server/http-v2/routes.test.ts`（純粋関数の単体テスト）、`tests/integration/http-v2/http-server.test.ts`（実ポート listen の統合テスト）

**Interfaces:**
- Consumes: `createV2McpHandler`（Task 11）、`validateRequestHeaders` / `applySecurityHeaders`（Task 10）、`toNodeHandler`（`@modelcontextprotocol/node`）
- Produces:
  - `transport.ts`: `interface FetchLikeHandler { fetch(request: Request): Promise<Response> }`、`createMcpNodeHandler(handler: FetchLikeHandler)`（**entry.ts 以外から呼ばない** — 設計書 §7.5）
  - `routes.ts`: `routeRequest(method, pathname): 'health' | 'ready' | 'mcp' | null`、`readyResponse(ready: boolean)`、`createRequestListener(deps: { mcpHandler; isReady })`
  - `entry.ts`: `startHttpV2Server(deps: { handler: FetchLikeHandler; isReady: () => boolean; host: string; port: number }): Promise<HttpV2ServerHandle>`、`HttpV2ServerHandle { server; port(): number; close(): Promise<void> }`

- [ ] **Step 1: `transport.ts` を実装**

`src/server/http-v2/transport.ts`:

```typescript
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Web-standard MCP handler shape. Declared structurally so the
 * @modelcontextprotocol/server import stays confined to server-factory.ts
 * and v2-adapter.ts (design doc §7.5).
 */
export interface FetchLikeHandler {
  fetch(request: Request): Promise<Response>;
}

/**
 * Convert a web-standard MCP handler into a Node.js request listener.
 * The only caller is entry.ts — do not import this from anywhere else.
 */
export const createMcpNodeHandler = (
  handler: FetchLikeHandler,
): ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => toNodeHandler(handler);
```

注意: `toNodeHandler` の正確な引数・戻り値型はインストール済み `@modelcontextprotocol/node@2.0.0` の型定義に従う。構造的部分型で一致しない場合のみ、型定義ファイルを読んで合わせる（`as any` は使わない）。

- [ ] **Step 2: 失敗するルーティング単体テストを書く**

`tests/unit/server/http-v2/routes.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { readyResponse, routeRequest } from '../../../../src/server/http-v2/routes.js';

describe('routeRequest', () => {
  it.each([
    ['GET', '/health', 'health'],
    ['GET', '/ready', 'ready'],
    ['POST', '/mcp', 'mcp'],
    ['GET', '/mcp', null],
    ['DELETE', '/mcp', null],
    ['POST', '/other', null],
    ['GET', '/', null],
  ] as const)('%s %s → %s', (method, pathname, expected) => {
    expect(routeRequest(method, pathname)).toBe(expected);
  });
});

describe('readyResponse', () => {
  it('returns 200 when ready', () => {
    expect(readyResponse(true)).toEqual({ status: 200, body: { status: 'ready' } });
  });

  it('returns 503 with NEXUS_STORAGE_UNAVAILABLE when not ready (design §9.4)', () => {
    expect(readyResponse(false)).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'NEXUS_STORAGE_UNAVAILABLE' },
    });
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run tests/unit/server/http-v2/routes.test.ts`
Expected: FAIL（`routes.js` のモジュール解決エラー）


- [ ] **Step 4: `routes.ts` を実装**

`src/server/http-v2/routes.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';

import { applySecurityHeaders, validateRequestHeaders } from './headers.js';

export type RouteName = 'health' | 'ready' | 'mcp' | null;

/**
 * Pure routing decision (unit-tested without sockets). Only POST /mcp is
 * routed to the MCP handler: the 2026-07-28 stateless handler answers
 * request/response exchanges, and GET/DELETE stream operations are out of
 * Phase 2 scope.
 */
export const routeRequest = (method: string | undefined, pathname: string): RouteName => {
  if (method === 'GET' && pathname === '/health') return 'health';
  if (method === 'GET' && pathname === '/ready') return 'ready';
  if (method === 'POST' && pathname === '/mcp') return 'mcp';
  return null;
};

/** Pure /ready response builder (design doc §9.4). */
export const readyResponse = (ready: boolean): { status: number; body: Record<string, string> } =>
  ready
    ? { status: 200, body: { status: 'ready' } }
    : { status: 503, body: { status: 'not_ready', reason: 'NEXUS_STORAGE_UNAVAILABLE' } };

export interface RoutesDeps {
  mcpHandler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  isReady: () => boolean;
}

const sendJson = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Node request listener dispatching /health, /ready and POST /mcp (design §8.1 / §9.1). */
export const createRequestListener = (deps: RoutesDeps) => {
  return (req: IncomingMessage, res: ServerResponse): void => {
    applySecurityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    switch (routeRequest(req.method, url.pathname)) {
      case 'health': {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      case 'ready': {
        const { status, body } = readyResponse(deps.isReady());
        sendJson(res, status, body);
        return;
      }
      case 'mcp': {
        const verdict = validateRequestHeaders(req.headers.host, req.headers.origin);
        if (!verdict.ok) {
          sendJson(res, 403, { error: verdict.reason });
          return;
        }
        void deps.mcpHandler(req, res);
        return;
      }
      default: {
        sendJson(res, 404, { error: 'Not found' });
      }
    }
  };
};
```

- [ ] **Step 5: `entry.ts` を実装**

`src/server/http-v2/entry.ts`:

```typescript
import { createServer, type Server } from 'node:http';

import { createMcpNodeHandler, type FetchLikeHandler } from './transport.js';
import { createRequestListener } from './routes.js';

export interface HttpV2ServerHandle {
  readonly server: Server;
  /** The bound port (post-listen; resolves an ephemeral port 0). */
  port(): number;
  close(): Promise<void>;
}

export interface HttpV2ServerDeps {
  handler: FetchLikeHandler;
  isReady: () => boolean;
  host: string;
  port: number;
}

/** Create and listen the local HTTP v2 server (design doc §8.1). */
export const startHttpV2Server = async (deps: HttpV2ServerDeps): Promise<HttpV2ServerHandle> => {
  const nodeHandler = createMcpNodeHandler(deps.handler);
  const listener = createRequestListener({
    mcpHandler: nodeHandler,
    isReady: deps.isReady,
  });
  const server = createServer(listener);
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(deps.port, deps.host, () => resolvePromise());
  });
  return {
    server,
    port: () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('HTTP v2 server is not listening');
      }
      return address.port;
    },
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error !== undefined ? reject(error) : resolvePromise()));
      }),
  };
};
```

- [ ] **Step 6: 単体テストが通ることを確認**

Run: `npx vitest run tests/unit/server/http-v2/routes.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS、tsc / lint exit 0


- [ ] **Step 7: 実ポートの統合テストを書く**

`tests/integration/http-v2/http-server.test.ts`。

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as V1McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { startHttpV2Server, type HttpV2ServerHandle } from '../../../src/server/http-v2/entry.js';
import { createV2McpHandler } from '../../../src/server/http-v2/server-factory.js';
import { registerV1Tools } from '../../../src/server/tools/registry/adapters/v1-adapter.js';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import { createTestNexusOptions } from '../../shared/create-test-nexus-options.js';

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2026-07-28',
} as const;

const readJsonRpc = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text();
  const dataLines = text.split('\n').filter((line) => line.startsWith('data:'));
  const payload = dataLines.length > 0 ? (dataLines[dataLines.length - 1] ?? '').slice(5).trim() : text;
  return JSON.parse(payload) as Record<string, unknown>;
};

describe('HTTP v2 server (integration)', () => {
  let handle: HttpV2ServerHandle | undefined;
  let ready = true;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    ready = true;
  });

  const boot = async (): Promise<string> => {
    const { options } = await createTestNexusOptions();
    const handler = createV2McpHandler({
      options,
      awaitInitialize: async () => {},
      limits: { topK: 100, maxResults: 1000 },
    });
    handle = await startHttpV2Server({ handler, isReady: () => ready, host: '127.0.0.1', port: 0 });
    return `http://127.0.0.1:${handle.port()}`;
  };

  const postMcp = (baseUrl: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...headers },
      body: JSON.stringify(body),
    });

  it('serves /health and /ready', async () => {
    const baseUrl = await boot();
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    ready = false;
    const notReady = await fetch(`${baseUrl}/ready`);
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ status: 'not_ready', reason: 'NEXUS_STORAGE_UNAVAILABLE' });

    ready = true;
    const readyOk = await fetch(`${baseUrl}/ready`);
    expect(readyOk.status).toBe(200);
    expect(await readyOk.json()).toEqual({ status: 'ready' });
  });

  it('lists the 6 tools with security headers and no session id', async () => {
    const baseUrl = await boot();
    const response = await postMcp(baseUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = await readJsonRpc(response);
    const result = body.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(6);
  });

  it('returns 404 for non-/mcp paths and for GET /mcp', async () => {
    const baseUrl = await boot();
    const notFound = await fetch(`${baseUrl}/nope`, { method: 'POST' });
    expect(notFound.status).toBe(404);
    const getMcp = await fetch(`${baseUrl}/mcp`);
    expect(getMcp.status).toBe(404);
  });

  it('rejects a non-loopback Origin with 403', async () => {
    const baseUrl = await boot();
    const response = await postMcp(
      baseUrl,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { origin: 'https://evil.example' },
    );
    expect(response.status).toBe(403);
  });

  it('rejects 2025-era requests (legacy protocol header)', async () => {
    const baseUrl = await boot();
    const response = await postMcp(
      baseUrl,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { 'mcp-protocol-version': '2025-03-26' },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
```


(a) 同ファイルに v1/v2 結果一致テストを追記（設計書 §10.2「`tools/call hybrid_search` で v1 と同一結果集合が返る」）:

```typescript
describe('v1/v2 hybrid_search parity', () => {
  it('returns the same result set on v1 (in-memory) and v2 (HTTP)', async () => {
    const { options } = await createTestNexusOptions();

    // v1 path: in-memory client over the v1 adapter.
    const v1Server = new V1McpServer(
      { name: 'nexus', version: '0.1.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    registerV1Tools(v1Server, buildToolHandlers(options));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const v1Client = new V1Client({ name: 'parity-v1', version: '0.0.1' });
    let v1Paths: string[];
    try {
      await Promise.all([v1Server.connect(serverTransport), v1Client.connect(clientTransport)]);
      const v1Result = await v1Client.callTool({
        name: 'hybrid_search',
        arguments: { query: 'authenticate', grepPattern: 'authenticate' },
      });
      const v1Structured = v1Result.structuredContent as { results: Array<{ filePath: string }> };
      v1Paths = v1Structured.results.map((r) => r.filePath).sort();
    } finally {
      await v1Client.close();
      await v1Server.close();
    }

    // v2 path: real HTTP on an ephemeral port.
    ready = true;
    const baseUrl = await boot();
    const response = await postMcp(baseUrl, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'hybrid_search', arguments: { query: 'authenticate', grepPattern: 'authenticate' } },
    });
    expect(response.status).toBe(200);
    const body = await readJsonRpc(response);
    const v2Result = body.result as { structuredContent: { results: Array<{ filePath: string }> } };
    const v2Paths = v2Result.structuredContent.results.map((r) => r.filePath).sort();

    expect(v2Paths).toEqual(v1Paths);
    expect(v2Paths).toContain('src/auth.ts');
  });
});
```

- [ ] **Step 8: 統合テストを実行して確認**

Run: `npx vitest run tests/integration/http-v2/`
Expected: PASS（6/6）。SSE ・レームの読み取りやステータスコードが実挙動と異なる場合は実レスポンスを確認してからヘルパー／アサーションを修正する（後退させる方向への緩和は不可）。

- [ ] **Step 9: 全件回帰**

Run: `npx vitest run && npm run lint && npx tsc --noEmit`
Expected: 全件 PASS、lint / tsc exit 0

- [ ] **Step 10: Commit**

```bash
git add src/server/http-v2/transport.ts src/server/http-v2/routes.ts src/server/http-v2/entry.ts tests/unit/server/http-v2/routes.test.ts tests/integration/http-v2/http-server.test.ts
git commit -m "feat(server): HTTP v2 ルーティングとエントリポイントを実装"
```

---

### Task 13: `nexus serve` サブコマンド + E2E + 最終検証

**Files:**
- Modify: `src/server/factory.ts`（`buildRuntimeOptions` 抽出）
- Create: `src/bin/commands/serve.ts`
- Modify: `src/bin/nexus.ts`（commands 配列 + ヘルプテキスト）
- Modify: `README.md`（`nexus serve` の短い節を追加）
- Test: `tests/unit/bin/serve.test.ts`（引数/優先順位/fail-closed）、`tests/e2e/http-v2-serve.test.ts`（実プロセス + SDK v2 クライアント）

**Interfaces:**
- Consumes: `buildNexusRuntime` / `initializeNexusRuntime`（src/server/index.ts）、`createV2McpHandler`（Task 11）、`startHttpV2Server`（Task 12）、Task 1 の `Config.http` / `assertHttpV2Constraints`
- Produces:
  - `NexusServerFactory.buildRuntimeOptions(config: Config): Promise<NexusRuntimeOptions>`（createRuntime からの抽出。初期化は呼び出し側責務のまま）
  - `parseServeArgs(args: string[]): ServeCliArgs`
  - `resolveServeEndpoint(cli: ServeCliArgs, config: Config): { host: string; port: number }`
  - `runServeCli(argv, env, deps: ServeCliDependencies): Promise<void>`、`main(args): Promise<void>`（aggregator-command と同型の依存注入パターン）

- [ ] **Step 1: factory.ts に `buildRuntimeOptions` を抽出**

`NexusServerFactory.createRuntime` の本体（設定検証〜 `buildNexusRuntime({...})` の引数オブジェクト構築まで）を、そのまま public static メソッド `buildRuntimeOptions(config: Config): Promise<NexusRuntimeOptions>` に移す。`createRuntime` は以下だけを残す:

```typescript
  static async createRuntime(config: Config): Promise<NexusRuntime> {
    return buildNexusRuntime(await NexusServerFactory.buildRuntimeOptions(config));
  }
```

注意: 本体には既存のプロジェクトロック取得・ログストリーム・EventProcessingManager 構築がそのまま含まれる。戻り値の import 型 `NexusRuntimeOptions` は `src/server/index.ts` から。STDIO 経路の挙動が変わらないことを、次の全件回帰では特に注意して確認する。

Run: `npx tsc --noEmit && npm run lint && npx vitest run tests/integration/server.test.ts tests/unit/bin/`
Expected: exit 0 / 既存テスト PASS

- [ ] **Step 2: 失敗する CLI 単体テストを書く**

`tests/unit/bin/serve.test.ts`（`tests/unit/bin/aggregator-command.test.ts` の依存注入パターンに倣う）:

```typescript
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { parseServeArgs, resolveServeEndpoint, runServeCli } from '../../../src/bin/commands/serve.js';
import type { Config } from '../../../src/types/index.js';

const configWithHttp = (http?: { host?: string; port?: number }): Config => {
  const config = { projectRoot: process.cwd() } as unknown as Config;
  if (http !== undefined) {
    config.http = { host: http.host ?? '127.0.0.1', port: http.port, maxTopK: 100, maxResultsLimit: 1000 };
  }
  return config;
};

describe('parseServeArgs', () => {
  it('parses serve flags', () => {
    const parsed = parseServeArgs(['--host', '127.0.0.1', '--port', '9200', '--project-root', '/tmp/x']);
    expect(parsed).toMatchObject({ host: '127.0.0.1', port: 9200, projectRoot: '/tmp/x', help: false });
  });

  it('defaults help to false and leaves host/port undefined', () => {
    expect(parseServeArgs([])).toEqual({ host: undefined, port: undefined, projectRoot: undefined, help: false });
  });
});

describe('resolveServeEndpoint', () => {
  it('prioritizes CLI over config over defaults', () => {
    const config = configWithHttp({ host: 'localhost', port: 9230 });
    expect(resolveServeEndpoint(parseServeArgs([]), config)).toEqual({ host: 'localhost', port: 9230 });
    expect(resolveServeEndpoint(parseServeArgs(['--host', '127.0.0.1', '--port', '9200']), config)).toEqual({
      host: '127.0.0.1',
      port: 9200,
    });
    expect(resolveServeEndpoint(parseServeArgs([]), configWithHttp())).toEqual({ host: '127.0.0.1', port: 9200 });
  });

  it('rejects a non-loopback host (fail-closed, design §3.2)', () => {
    expect(() => resolveServeEndpoint(parseServeArgs(['--host', '0.0.0.0']), configWithHttp())).toThrow(/loopback/);
    expect(() => resolveServeEndpoint(parseServeArgs([]), configWithHttp({ host: '0.0.0.0' }))).toThrow(/loopback/);
  });

  it('rejects an invalid port', () => {
    expect(() => resolveServeEndpoint(parseServeArgs(['--port', 'abc']), configWithHttp())).toThrow(/port/);
    expect(() => resolveServeEndpoint(parseServeArgs(['--port', '99999']), configWithHttp())).toThrow(/port/);
  });
});

describe('runServeCli --help / fail-closed', () => {
  it('prints help and exits without starting anything', async () => {
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const exit = vi.fn();
    await runServeCli(['--help'], {}, { output, errorOutput, exit, signalSource: new EventEmitter() });
    expect(exit).not.toHaveBeenCalled();
    expect(output.read()?.toString() ?? '').toContain('nexus serve');
  });

  it('fails fast for a non-loopback host before any runtime construction', async () => {
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const exit = vi.fn();
    await runServeCli(['--host', '0.0.0.0'], {}, { output, errorOutput, exit, signalSource: new EventEmitter() });
    expect(exit).toHaveBeenCalledWith(1);
    expect(errorOutput.read()?.toString() ?? '').toMatch(/loopback/);
  });
});
```

（`EventEmitter` は `node:events` から import。）

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run tests/unit/bin/serve.test.ts`
Expected: FAIL（`src/bin/commands/serve.js` のモジュール解決エラー）


- [ ] **Step 4: `src/bin/commands/serve.ts` を実装（引数解析 + 優先順位解決）**

`src/bin/commands/serve.ts` の前半:

```typescript
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';

import { isLoopbackHost } from '../../config/index.js';
import type { Config } from '../../types/index.js';

export interface ServeCliArgs {
  host: string | undefined;
  port: number | undefined;
  projectRoot: string | undefined;
  help: boolean;
}

const parsePositiveInt = (raw: string): number | undefined => {
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

export const parseServeArgs = (args: string[]): ServeCliArgs => {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'project-root': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  const rawPort = values.port;
  const parsedPort = rawPort === undefined ? undefined : parsePositiveInt(rawPort);
  if (rawPort !== undefined && parsedPort === undefined) {
    throw new Error(`Invalid port: ${rawPort}`);
  }
  return {
    host: values.host,
    port: parsedPort,
    projectRoot: values['project-root'],
    help: values.help === true,
  };
};

/** CLI 引数 > Config.http > 既定値（127.0.0.1:9200）。loopback 以外は fail-closed。 */
export const resolveServeEndpoint = (
  cli: ServeCliArgs,
  config: Config,
): { host: string; port: number } => {
  const host = cli.host ?? config.http?.host ?? '127.0.0.1';
  const port = cli.port ?? config.http?.port ?? 9200;
  if (!isLoopbackHost(host)) {
    throw new Error(
      `nexus serve can only bind to a loopback interface (127.0.0.1, localhost, or ::1), ` +
        `but received "${host}".`,
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${String(port)}`);
  }
  return { host, port };
};
```

注意: `config` は既に `transportMode: 'v2-http'` で loadConfig 済み（`assertHttpV2Constraints` 通過済み）のため `.nexus.json` 側の host は loopback が保証されているが、CLI 指定値はここで最終チェックする（fail-closed）。

(b) 同ファイルに `runServeCli` と `main` を追加（aggregator-command と同型の依存注入パターン）:

```typescript
import { createV2McpHandler } from '../../server/http-v2/server-factory.js';
import { startHttpV2Server } from '../../server/http-v2/entry.js';
import type { NexusRuntime, NexusServerOptions } from '../../server/index.js';
import { loadConfig } from '../../config/index.js';
import { buildNexusRuntime, initializeNexusRuntime, type NexusRuntimeOptions } from '../../server/factory.js';

export interface ServeCliDependencies {
  output: Writable;
  errorOutput: Writable;
  exit: (code?: number) => void;
  signalSource: EventEmitter;
  buildRuntimeOptions?: (config: Config) => Promise<NexusRuntimeOptions>;
  createRuntime?: (config: Config) => Promise<NexusRuntime>;
  createMcpHandler?: typeof createV2McpHandler;
  startServer?: typeof startHttpV2Server;
}

const DEFAULT_SERVE_DEPS: Partial<ServeCliDependencies> = {
  buildRuntimeOptions: NexusServerFactory.buildRuntimeOptions,
  createRuntime: NexusServerFactory.createRuntime,
  createMcpHandler: createV2McpHandler,
  startServer: startHttpV2Server,
};

/** Render the serve subcommand help text. */
const printServeHelp = (output: Writable): void => {
  output.write(`Usage: nexus serve [options]

Start a local MCP v2 HTTP server bound to a loopback interface.

Options:
  --host <address>       Bind address (default: 127.0.0.1, or .nexus.json http.host)
  --port <number>        Listen port (default: 9200, or .nexus.json http.port)
  --project-root <path>  Project root directory (default: current working directory)
  -h, --help             Show this help
`);
};

/** Run the nexus serve CLI with dependency injection for testability. */
export const runServeCli = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: ServeCliDependencies,
): Promise<void> => {
  const output = deps.output;
  const errorOutput = deps.errorOutput;
  const merged = { ...DEFAULT_SERVE_DEPS, ...deps };

  let cli: ServeCliArgs;
  try {
    cli = parseServeArgs(argv);
  } catch (error) {
    errorOutput.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    deps.exit(1);
    return;
  }

  if (cli.help) {
    printServeHelp(output);
    return;
  }

  const projectRoot = cli.projectRoot ?? env.NEXUS_PROJECT_ROOT ?? process.cwd();

  let config: Config;
  let runtime: NexusRuntime;
  try {
    config = await loadConfig({ projectRoot, env, transportMode: 'v2-http' });
    const endpoint = resolveServeEndpoint(cli, config);
    runtime = await merged.createRuntime!(config);
    await initializeNexusRuntime(runtime);

    const handler = merged.createMcpHandler!({
      options: runtime.options as NexusServerOptions,
      awaitInitialize: async () => {
        if (runtime.initializePromise !== undefined) {
          await runtime.initializePromise;
        }
      },
      limits: { topK: config.http!.maxTopK, maxResults: config.http!.maxResultsLimit },
      serverInfo: { name: 'nexus', version: runtime.options.version ?? '0.1.0' },
    });

    const handle = await merged.startServer!({
      handler,
      isReady: () => runtime.options.ready === true,
      host: endpoint.host,
      port: endpoint.port,
    });

    output.write(`nexus serve listening on ${endpoint.host}:${handle.port()}\n`);

    const shutdown = async (): Promise<void> => {
      await handle.close();
      await runtime.close();
    };

    merged.signalSource!.once('SIGINT', shutdown);
    merged.signalSource!.once('SIGTERM', shutdown);
  } catch (error) {
    errorOutput.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    if (runtime! !== undefined) {
      await runtime.close();
    }
    deps.exit(1);
  }
};

/** Entry point for the serve subcommand. */
export const main = async (args: string[]): Promise<void> => {
  await runServeCli(args, process.env, {
    output: process.stdout,
    errorOutput: process.stderr,
    exit: (code) => process.exit(code ?? 0),
    signalSource: process,
  });
};
```

注意: `runtime.options` は `NexusRuntimeOptions` 型で `NexusServerOptions` を拡張していることが前提。もし型不一致がある場合は `src/server/index.ts` 側の `NexusRuntimeOptions` に `version?: string` と `ready?: boolean` を追加する。`ready` は `initializeNexusRuntime` 完了時に `true` にセットする。`runtime.initializePromise` が存在しない場合は `awaitInitialize` は no-op とする。

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run tests/unit/bin/serve.test.ts`
Expected: PASS（5/5）

- [ ] **Step 6: Commit**

```bash
git add src/bin/commands/serve.ts tests/unit/bin/serve.test.ts src/server/factory.ts
git commit -m "feat(bin): nexus serve サブコマンドの引数解析と実行を追加"
git commit --amend -m "feat(bin): nexus serve サブコマンドの引数解析と実行を追加"
git commit -m "feat(bin): nexus serve サブコマンドの引数解析と実行を追加"
```

---

### Task 14: `nexus.ts` への serve サブコマンド配線

**Files:**
- Modify: `src/bin/nexus.ts`
- Test: `tests/unit/bin/nexus.test.ts`（新規、または既存の拡張）

**Interfaces:**
- Consumes: `main`（`src/bin/commands/serve.js`）、`COMMANDS` 配列
- Produces: `commands` 配列に `'serve'` 追加、ヘルプテキスト更新

- [ ] **Step 1: 既存 `nexus.ts` のコマンド構造を確認**

Run: `grep -n "commands\|help\|serve" src/bin/nexus.ts`
Expected: `commands` 配列と help テンプレートが存在する。`serve` はまだ含まれていない。

- [ ] **Step 2: 失敗するテストを書く**

`tests/unit/bin/nexus.test.ts`（新規作成、または既存テストファイルに追記）:

```typescript
import { describe, expect, it } from 'vitest';

import { commands } from '../../../src/bin/nexus.js';

describe('nexus CLI commands', () => {
  it('includes serve in the command list', () => {
    expect(commands).toContain('serve');
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run tests/unit/bin/nexus.test.ts`
Expected: FAIL（`commands` 配列に `serve` が含まれない）

- [ ] **Step 4: `nexus.ts` に serve サブコマンドを追加**

`src/bin/nexus.ts`:

1. `commands` 定数（例: `['index', 'serve', 'http-bridge', 'dashboard', 'aggregator']`）に `'serve'` を追加する。既存 stdio 経路は変更しない。
2. `runCommand(command, args)` スイッチ（または if/else チェーン）に `case 'serve':` を追加:

```typescript
    case 'serve': {
      const { main: serveMain } = await import('./commands/serve.js');
      await serveMain(args);
      break;
    }
```

3. ヘルプテキストに `serve` の1行説明を追加:

```text
  serve                  Start the local MCP v2 HTTP server (loopback only)
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run tests/unit/bin/nexus.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS、tsc / lint exit 0

- [ ] **Step 6: Commit**

```bash
git add src/bin/nexus.ts tests/unit/bin/nexus.test.ts
git commit -m "feat(bin): nexus.ts に serve サブコマンドを配線"
git commit --amend -m "feat(bin): nexus.ts に serve サブコマンドを配線"
git commit -m "feat(bin): nexus.ts に serve サブコマンドを配線"
```

---

### Task 15: README 更新

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 設計書 §6.1、§8.1
- Produces: `nexus serve` の簡潔なドキュメント節

- [ ] **Step 1: README に `nexus serve` 節を追加**

`README.md` の「### 🌉 HTTP Bridge 経由で接続する場合」直後（または「## 📖 使い方」セクション内）に追加:

```markdown
### MCP v2 HTTP サーバーを直接起動する

ローカルで MCP プロトコル `2026-07-28` 準拠の HTTP サーバーを直接起動できます。デフォルトは loopback（`127.0.0.1:9200`）に bind し、非 loopback インターフェースは指定できません（`--allow-network` は将来フェーズで追加）。

```bash
nexus serve
nexus serve --host 127.0.0.1 --port 9200
```

設定は `.nexus.json` の `http` ブロックまたは `NEXUS_HTTP_HOST` / `NEXUS_HTTP_PORT` 環境変数で上書きできます。外部 Embedding Provider（`openai-compat` / `bedrock`）は local-only モードで拒否されます。
```

- [ ] **Step 2: リンク・表を更新**

必要に応じて「MCP ツール一覧」や「特徴」セクションに `nexus serve` への言及を追加する。既存の http-bridge 記述は変更しない。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README に nexus serve を追加"
git commit --amend -m "docs: README に nexus serve を追加"
git commit -m "docs: README に nexus serve を追加"
```

---

### Task 16: E2E テスト

**Files:**
- Create: `tests/e2e/http-v2-serve.test.ts`
- Modify: `package.json`（`test:e2e` スクリプトが存在しなければ追加）

**Interfaces:**
- Consumes: `npm run build` 成果物、`nexus serve` コマンド、SDK v2 `Client`
- Produces: `NEXUS_E2E=1` ゲートで動作する E2E テスト

- [ ] **Step 1: E2E ゲート付きテストを書く**

`tests/e2e/http-v2-serve.test.ts`:

```typescript
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

const isE2EEnabled = process.env.NEXUS_E2E === '1';

describe.skipIf(!isE2EEnabled)('nexus serve E2E', () => {
  let projectRoot: string | undefined;
  let proc: ReturnType<typeof import('node:child_process').spawn> | undefined;

  afterEach(async () => {
    proc?.kill();
    if (projectRoot !== undefined) {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('starts, answers /health, and lists tools via Streamable HTTP', async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'nexus-serve-e2e-'));
    await writeFile(
      path.join(projectRoot, '.nexus.json'),
      JSON.stringify({ embedding: { provider: 'ollama', model: 'nomic-embed-text' } }),
    );

    const { spawn } = await import('node:child_process');
    proc = spawn('node', ['dist/bin/nexus.js', 'serve', '--port', '0'], {
      cwd: projectRoot,
      env: { ...process.env, NEXUS_E2E: '1' },
    });

    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      proc!.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.includes('nexus serve listening on')) {
          resolve();
        }
      });
      proc!.stderr.on('data', (chunk) => reject(new Error(chunk.toString())));
      proc!.on('error', reject);
      setTimeout(() => reject(new Error('nexus serve did not start in time')), 30000);
    });

    // Port discovery from stdout: "nexus serve listening on 127.0.0.1:<port>"
    const match = /127\.0\.0\.1:(\d+)/.exec(proc.stdout.toString() ?? '');
    expect(match).not.toBeNull();
    const port = Number(match![1]);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = (await response.json()) as { result?: { tools: Array<{ name: string }> } };
    expect(body.result?.tools.map((t) => t.name)).toEqual([
      'semantic_search',
      'grep_search',
      'hybrid_search',
      'get_context',
      'index_status',
      'reindex',
    ]);
  });
});
```

- [ ] **Step 2: `test:e2e` スクリプトを確認・追加**

`package.json` の `scripts` に以下があれば OK:

```json
"test:e2e": "NEXUS_E2E=1 npx vitest run tests/e2e/"
```

無ければ追加する。

- [ ] **Step 3: E2E テストを実行**

```bash
npm run build
NEXUS_E2E=1 npx vitest run tests/e2e/http-v2-serve.test.ts
```
Expected: PASS（1/1）。`ollama` が利用可能である前提。利用不可の場合はテスト専用の in-memory Embedding Provider 構成を `.nexus.json` テンプレートに追加する方法を別途検討するが、本計画では ollama 既定とする。

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/http-v2-serve.test.ts package.json
git commit -m "test(e2e): nexus serve の実プロセス E2E テストを追加"
git commit --amend -m "test(e2e): nexus serve の実プロセス E2E テストを追加"
git commit -m "test(e2e): nexus serve の実プロセス E2E テストを追加"
```

---

### Task 17: 最終検証とまとめコミット

**Files:**
- 変更済み全ファイル

**Interfaces:**
- Consumes: 全タスクの成果物
- Produces: 後方互換性の証明、全体テスト PASS

- [ ] **Step 1: 全件テストを実行**

Run:

```bash
npm run lint
npx tsc --noEmit
npx vitest run
npm run build
```

Expected: すべて exit 0。既存 v1 経路のテストは 1 件も変更せず全件 PASS。

- [ ] **Step 2: 受入基準を確認**

設計書 §12（後方互換性と受入基準対応）に対し、以下を目視確認:

| 受入基準 | 確認方法 |
|---|---|
| §20.1 MCP v2 `/mcp` 接続 | `tests/integration/http-v2/http-server.test.ts` |
| §20.1 `Mcp-Session-Id` 不使用・セッション Map 不在 | テストで `response.headers.get('mcp-session-id')` を `null` 確認 |
| §20.1 `server/discover` 成功 | `tests/unit/server/http-v2/server-factory.test.ts` |
| §20.1 必要ヘッダー検証 | SDK v2 自動 + Origin/Host 自前テスト |
| §20.2 従来 `nexus` stdio 利用 | 既存テスト全件 PASS（変更なし） |
| §20.2 `nexus http-bridge` 利用 | 既存テスト全件 PASS（変更なし） |
| §20.2 既存 Tool 利用 | v1 アダプタ経由で維持、パリティテスト |
| §20.4 Local HTTP loopback デフォルト | `nexus serve` は 127.0.0.1 のみ bind |
| §20.4 外部ネットワーク不要 | LocalContentStore / SQLite / LanceDB / local-only 制約 |
| §16.5 `topK` 上限 | v2 アダプタ `.max()` テスト |

- [ ] **Step 3: まとめコミット（任意）**

各タスクですでにコミットしている場合は不要。追加で未コミットの変更が残っていればコミットする。

```bash
git status
git commit -m "feat: Nexus MCP v2 HTTP server (nexus serve) 実装完了"
```

---

## Self-Review

**1. Spec coverage:** 設計書 §4〜§12 に対して、以下の対応タスクを確認:

| 設計書セクション | 対応タスク | 備考 |
|---|---|---|
| §4 決定事項（v1 維持等） | Global Constraints + Task 7 | v1 アダプタで既存パスを維持 |
| §6.1 local-only 契約 | Task 1 | `assertHttpV2Constraints` で外部 Provider 拒否 |
| §7.1 ツールレジストリ | Task 4, 5, 7, 8 | schemas-neutral → definitions → v1/v2 adapters |
| §7.2 http-v2 モジュール | Task 10, 11, 12 | net / headers / server-factory / transport / routes / entry |
| §7.3 storage interfaces | Task 3, 9 | metadata-store / vector-store 移設、LocalContentStore 新設 |
| §7.4 bin/commands/serve.ts | Task 13, 14 | サブコマンド実装・配線 |
| §7.5 依存方向ルール | Global Constraints + 各タスク | import 制限を守る |
| §8.1 リクエストライフサイクル | Task 11, 12 | createMcpHandler + routes + entry |
| §8.2 スキーマ変換フロー | Task 4, 7, 8 | v1/v2 アダプタ |
| §8.3 ContentStore 導入 | Task 9 | LocalContentStore + createContentReader |
| §9 エラーハンドリング | Task 2, 8 | NexusErrorCode + withErrorCode |
| §10.2 新規テスト | Task 1〜16 | 単体/統合/E2E テスト |
| §10.3 リソース制御 | Task 1, 8 | maxTopK / maxResultsLimit + `.max()` |
| §11 Phase 3 接続点 | Task 12, 13 | 認証差込口、start/stop フック集約 |
| §12 受入基準 | Task 17 | 最終確認マトリクス |

**2. Placeholder scan:** 計画内に "TBD" / "TODO" / "implement later" / "fill in details" / "適切なエラー処理" 等のplaceholder は含めていない。すべてのステップに実際のコード/コマンド/期待値を記載。

**3. Type consistency:**
- `HttpConfig`（Task 1）: `host`, `port?`, `maxTopK`, `maxResultsLimit`
- `NexusServerOptions`（Task 6）: `contentStore?: IContentStore`（Task 9 で追加）
- `V2ToolLimits`（Task 8）: `topK`, `maxResults`
- `V2ServerFactoryDeps`（Task 11）: `options`, `awaitInitialize`, `limits`, `serverInfo?`
- `HttpV2ServerDeps`（Task 12）: `handler`, `isReady`, `host`, `port`
- `ServeCliArgs`（Task 13）: `host?`, `port?`, `projectRoot?`, `help`

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-09-nexus-mcp-v2-migration.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**
