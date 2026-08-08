# ContentStore Contract Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the `ContentStore` contract so that `readRange` operates within a clearly-defined workspace/revision scope, resolving the hash-vs-path mismatch raised in CodeRabbit review.

**Architecture:** Keep `ContentStore` as a hash-keyed blob store (put/get/delete/exists) and add a factory that produces `ContentStore` instances bound to a specific `(workspaceId, revisionId)`. This makes `readRange(path, ...)` unambiguous while preserving the existing hash-based API shape. The bound instance internally resolves `path` → `contentHash` via `MetadataStore` and extracts the requested line range.

**Tech Stack:** TypeScript, Node.js >=24, npm, Vitest, better-sqlite3, LanceDB

## Global Constraints

- Do not modify existing v1 tool handlers or tests.
- Do not introduce external source-code transmission.
- Keep local-first behavior intact.
- Do not commit credentials, tokens, machine-specific paths, or generated local state.
- Match existing TypeScript style and project structure.
- Type error suppression (`as any`, `@ts-ignore`) is forbidden.

---

### Task 1: Update `REQUIREMENTS.md` ContentStore contract

**Files:**
- Modify: `REQUIREMENTS.md:447-453`

**Interfaces:**
- Consumes: Existing `ContentStore` definition from §7.1
- Produces: Updated `ContentStore` + new `ContentStoreFactory` definitions

- [x] **Step 1: Replace the ContentStore block**

Replace lines 447-453 with:

```typescript
interface ContentStore {
  put(contentHash: string, content: Uint8Array): Promise<void>;
  get(contentHash: string): Promise<Uint8Array | null>;
  delete(contentHash: string): Promise<void>;
  exists(contentHash: string): Promise<boolean>;
  readRange(path: string, startLine: number, endLine: number): Promise<string>;
}

interface ContentStoreFactory {
  getStore(workspaceId: string, revisionId: string): ContentStore;
}
```

- [x] **Step 2: Add binding explanation after the interface block**

Insert the following paragraph after the new block (before `## 7.2 ローカル実装`):

```markdown
`ContentStore` instances are always bound to a single `(workspaceId, revisionId)` pair.
`ContentStoreFactory.getStore(workspaceId, revisionId)` returns a store scoped to that workspace/revision.
`put` / `get` / `delete` / `exists` operate on content hashes, which are globally unique across all workspaces and revisions.
`readRange` resolves `path` to a `contentHash` through the scoped `MetadataStore` and returns the requested line range.
This binding removes ambiguity when the same `path` exists in multiple workspaces or revisions.
```

- [x] **Step 3: Verify the section renders correctly**

Run: `npx markdownlint-cli2 REQUIREMENTS.md`
Expected: No errors in the modified section.

---

### Task 2: Update design document ContentStore contract

**Files:**
- Modify: `docs/superpowers/specs/2026-08-07-nexus-mcp-v2-migration-design.md:165-180`
- Modify: `docs/superpowers/specs/2026-08-07-nexus-mcp-v2-migration-design.md:259-271`

**Interfaces:**
- Consumes: Updated `ContentStore` + `ContentStoreFactory` from Task 1
- Produces: Consistent design doc sections 7.3 and 8.3

- [x] **Step 1: Update the ContentStore interface block in §7.3**

Replace lines 167-174 with:

```typescript
interface ContentStore {
  put(contentHash: string, content: Uint8Array): Promise<void>;
  get(contentHash: string): Promise<Uint8Array | null>;
  delete(contentHash: string): Promise<void>;
  exists(contentHash: string): Promise<boolean>;
  readRange(path: string, startLine: number, endLine: number): Promise<string>;
}

interface ContentStoreFactory {
  getStore(workspaceId: string, revisionId: string): ContentStore;
}
```

- [x] **Step 2: Add binding explanation in §7.3**

After the interface block and before "Phase 2 では `LocalContentStore` のみ実装。", insert:

```markdown
`ContentStore` は `(workspaceId, revisionId)` 単位で束縛される。
`ContentStoreFactory.getStore(workspaceId, revisionId)` は、指定された workspace/revision にスコープされた `ContentStore` インスタンスを返す。
`readRange` は束縛されたスコープ内で `path` → `contentHash` を `MetadataStore` で解決し、`get` したバイト列から行範囲を抽出する。
同じ `path` が複数の workspace や revision に存在する場合でも、スコープによって一意に解決できる。
```

- [x] **Step 3: Update §8.3 flow diagram**

Replace lines 261-271 with:

```text
現状:
  get_context / hybrid_search snippet
    → loadFileContent(filePath)

Phase 1b 以降:
  同ハンドラ
    → ContentStoreFactory.getStore(workspaceId, revisionId)
         → ContentStore.readRange(path, startLine, endLine)
              └─ LocalContentStore
                   → PathSanitizer 検証後に FS 読み出し
```

- [x] **Step 4: Verify the design doc renders correctly**

Run: `npx markdownlint-cli2 docs/superpowers/specs/2026-08-07-nexus-mcp-v2-migration-design.md`
Expected: No errors in the modified sections.

---

### Task 3: Create TypeScript interfaces

**Files:**
- Create: `src/storage/interfaces/content-store.ts`

**Interfaces:**
- Consumes: None (new file)
- Produces: `IContentStore`, `IContentStoreFactory`

- [x] **Step 1: Create the interface file**

Create `src/storage/interfaces/content-store.ts` with:

```typescript
/**
 * Content-addressed blob storage for file contents.
 *
 * Each instance is scoped to a single workspace/revision pair via
 * {@link IContentStoreFactory.getStore}. The hash-based methods (put, get,
 * delete, exists) operate on globally unique content hashes. The path-based
 * method (readRange) resolves `path` to a hash through the scoped metadata
 * store and returns the requested line range.
 */
export interface IContentStore {
  /**
   * Persist content bytes keyed by its content hash.
   */
  put(contentHash: string, content: Uint8Array): Promise<void>;

  /**
   * Retrieve content bytes by content hash, or null if absent.
   */
  get(contentHash: string): Promise<Uint8Array | null>;

  /**
   * Remove content bytes by content hash.
   */
  delete(contentHash: string): Promise<void>;

  /**
   * Return true if content bytes for the hash exist.
   */
  exists(contentHash: string): Promise<boolean>;

  /**
   * Resolve `path` within the bound workspace/revision to a content hash,
   * retrieve the bytes, and return the requested inclusive line range as a
   * string.
   */
  readRange(path: string, startLine: number, endLine: number): Promise<string>;
}

/**
 * Factory for workspace/revision-scoped {@link IContentStore} instances.
 */
export interface IContentStoreFactory {
  /**
   * Return a ContentStore bound to the given workspace and revision.
   */
  getStore(workspaceId: string, revisionId: string): IContentStore;
}
```

- [x] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/storage/interfaces/content-store.ts`
Expected: No type errors.

---

### Task 4: Project-wide verification

**Files:**
- All modified/created files

- [x] **Step 1: Run linter**

Run: `npm run lint`
Expected: Exit 0.

- [x] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: Exit 0.

- [x] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All tests pass.

- [x] **Step 4: Review diff**

Run: `git diff --stat`
Expected: Only the intended files are changed.

---

### Task 5: Fix remaining unresolved CodeRabbit threads in design doc

**Files:**
- Modify: `docs/superpowers/specs/2026-08-07-nexus-mcp-v2-migration-design.md:244`
- Modify: `docs/superpowers/specs/2026-08-07-nexus-mcp-v2-migration-design.md:370`
- Modify: `REQUIREMENTS.md:1403-1420`

**Interfaces:**
- Consumes: PR #242 unresolved review threads (fetched via GitHub GraphQL)
- Produces: Consistent legacy option values, config priority order, and phase definitions

- [x] **Step 1: Fix `legacy` option valid values**

Replace `"accept"` with SDK v2's actual value `"stateless"` in the description of `createMcpHandler` `legacy` option.

- [x] **Step 2: Fix configuration priority order**

Update Phase 3 connection point table to state: CLI args > environment variables (including `NEXUS_HTTP_*`) > `.nexus.json` > defaults.

- [x] **Step 3: Unify migration phase definitions**

Update `REQUIREMENTS.md` §19 so Phase 2 includes `nexus serve`, loopback default/fail-closed, `/health`, `/ready`; Phase 3 covers `--allow-network`, auth, systemd, and HTTP Bridge v2. This matches the design document §3.1 and §4.1.

- [x] **Step 4: Verify with lint and type check**

Run: `npm run lint` and `npx tsc --noEmit src/storage/interfaces/content-store.ts`
Expected: Exit 0 for lint, no output for type check.

---

## Self-Review

**1. Spec coverage:**
- CodeRabbit concern: ContentStore key/hash contract mismatch → addressed by binding to workspace/revision
- CodeRabbit concern: readRange path ambiguity → addressed by scoped store
- CodeRabbit concern: exists and readonly handling → already present in spec, unchanged
- CodeRabbit concern: get_context and snippet common flow → updated in §8.3
- CodeRabbit concern: `legacy` option valid values → fixed `"accept"` → `"stateless"`
- CodeRabbit concern: config priority order → fixed to CLI > env vars > `.nexus.json` > defaults
- CodeRabbit concern: migration phase mismatch → unified REQUIREMENTS.md §19 with design doc

**2. Placeholder scan:**
- No TBD/TODO/fill-in-details in steps.
- All code blocks contain concrete content.

**3. Type consistency:**
- `ContentStore`/`IContentStore` signatures match across REQUIREMENTS.md, design doc, and TypeScript file.
- `ContentStoreFactory`/`IContentStoreFactory` signatures match across all three locations.
- `legacy` option values now match SDK v2 documentation.
