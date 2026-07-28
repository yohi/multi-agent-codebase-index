# MCP × Agent Skills 役割分離・再設計 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `AGENTS.md` を軽量化し、`.agents/skills/code-search.md` に Nexus × CodeGraph の標準探索パイプラインを定義し、Nexus MCP の JSON Schema とインデックス除外設定を最適化する。

**Architecture:** 3層分離。`AGENTS.md` は決定論的トリガー定義のみ常駐、`.agents/skills/*.md` はタスク別手順を動的ロード、Nexus MCP は実行・検索を担当。CodeGraph は `.codegraph/` 存在時のみ活用。

**Tech Stack:** TypeScript, Node.js >=24, MCP SDK, Vitest, ESLint, Zod.

## Global Constraints

- TypeScript strict types. `npm run lint` fails on `any` and bare `@ts-ignore`; never add `@ts-expect-error`.
- Do not commit machine-specific absolute paths, credentials, tokens, or generated local state.
- Do not create new project-level agent configuration files or directories; edit existing canonical files only.
- Preserve local-first behavior; no external data transmission unless explicitly asked.
- Run `npm run lint` before claiming TypeScript changes are complete.
- Prefer running install, lint, build, and tests inside the devcontainer if `.devcontainer/` is available; do not run git commands inside the devcontainer.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `AGENTS.md` | プロジェクト概要、必須制約、ツール選択トリガー、検証方針のみ（50行以内） |
| `.agents/skills/code-search.md` | コード探索タスクの標準パイプライン、One-Call 行動パターン、Deferred Loading 手順 |
| `src/config/index.ts` | デフォルト `watcher.ignorePaths` に `.agents/`、`.nexus/`、`AGENTS.md` を追加 |
| `src/server/index.ts` | MCP ツール登録時の JSON Schema description を簡潔化 |
| `tests/unit/config/index.test.ts` | `ignorePaths` に新規除外パターンが含まれることを検証 |
| `docs/superpowers/plans/2026-07-28-mcp-skills-redesign.md` | 本実装計画書 |

---

## Task 1: Phase 1 — `AGENTS.md` 軽量化

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: none
- Produces: 50行以内の新しい `AGENTS.md`

- [ ] **Step 1: Read current AGENTS.md**

Run:
```bash
wc -l AGENTS.md
```
Expected: 93 lines

- [ ] **Step 2: Rewrite AGENTS.md to 50 lines or fewer**

Replace the entire file with content containing only:
1. Project overview (2 lines)
2. Mandatory constraints (3 lines)
3. Tool selection triggers (5 lines)
4. Verification policy (2 lines)

Keep the existing links to `SPEC.md`, `docs/configuration.md`, `docs/setup.md`, `docs/distribution.md`, and `docs/observability/README.md` inline where necessary.
Move the detailed "Nexus MCP Usage Guidelines" to `.agents/skills/code-search.md` (Task 2).

Example structure:
```markdown
# Instructions for AI Agents (Nexus)

Nexus is a local-first MCP server for codebase indexing, hybrid search,
and precise context retrieval for AI agents.

Keep this file small; prefer authoritative docs over duplicating details here.

## Mandatory Constraints

- When installing or configuring, ask the user to choose **Source Build** or **Package Usage** before running setup commands. Never ask for secrets or GitHub tokens in chat.
- Do not commit machine-specific absolute paths, credentials, tokens, or generated local state.
- Do not create new project-level agent configuration files or directories; edit existing canonical files only.

## Tool Selection Triggers

- Code investigation / design exploration → load `.agents/skills/code-search.md`
- Structural / call-tree tracing (only if `.codegraph/` exists) → use `codegraph_explore`
- Vague or conceptual search → use `nexus/hybrid_search`
- Exact symbol or error-string search → use `nexus/grep_search`
- Minimal file context retrieval → use `nexus/get_context` with `startLine` and `endLine`

## Verification

- Run the narrowest relevant Vitest test first, then `npm run lint` for TypeScript changes.
```

- [ ] **Step 3: Verify line count**

Run:
```bash
wc -l AGENTS.md
```
Expected: 50 or fewer lines

- [ ] **Step 4: Commit**

```bash
GIT_MASTER=1 git add AGENTS.md
GIT_MASTER=1 git commit -m "docs: AGENTS.mdを軽量化しツール選択トリガーを明確化"
```

---

## Task 2: Phase 2 — `.agents/skills/code-search.md` 作成

**Files:**
- Create: `.agents/skills/code-search.md`
- Modify: none

**Interfaces:**
- Consumes: content removed from `AGENTS.md` in Task 1
- Produces: `.agents/skills/code-search.md`

- [ ] **Step 1: Create `.agents/skills/` directory**

```bash
mkdir -p .agents/skills
```

- [ ] **Step 2: Write `.agents/skills/code-search.md`**

Content must include:
1. When to load this file (trigger phrases)
2. Standard pipeline: task classification → choose index → get context → act
3. One-Call pattern: call `get_context` for top candidates before returning search results
4. Deferred Loading: return summary + line numbers first, expand only when needed
5. Nexus tool usage rules: `index_status` before search, `hybrid_search` for vague, `grep_search` for exact, `get_context` with line ranges

- [ ] **Step 3: Verify file exists and is readable**

Run:
```bash
ls -la .agents/skills/code-search.md
wc -l .agents/skills/code-search.md
```
Expected: file exists, line count > 20

- [ ] **Step 4: Commit**

```bash
GIT_MASTER=1 git add .agents/skills/code-search.md
GIT_MASTER=1 git commit -m "docs: Nexus × CodeGraph コード探索手順を追加"
```

---

## Task 3: Phase 3 — Nexus MCP インデックス除外設定追加

**Files:**
- Modify: `src/config/index.ts`
- Modify: `tests/unit/config/index.test.ts`

**Interfaces:**
- Consumes: `Config` type, `DEFAULT_CONFIG` function
- Produces: updated default `watcher.ignorePaths`

- [ ] **Step 1: Locate default ignorePaths in `src/config/index.ts`**

Run:
```bash
grep -n "ignorePaths:" src/config/index.ts
```
Expected: around line 62 inside `DEFAULT_CONFIG`

- [ ] **Step 2: Add `.agents/`, `.nexus/`, and `AGENTS.md` to default ignorePaths**

Current default list includes items such as `node_modules`, `.git`, `.claude`, etc. Add the three entries in alphabetical/logical order. Use exact strings:
- `.agents/`
- `.nexus/`
- `AGENTS.md`

For `.nexus/`, note that `.nexus` is already present, so add `.nexus/` as a redundant directory form to satisfy the spec requirement explicitly.

- [ ] **Step 3: Add test for new ignore paths**

In `tests/unit/config/index.test.ts`, locate the test titled `includes Claude Code, lockfile entries, and the secret denylist in the default ignorePaths`.
Add assertions:
```typescript
expect(ignorePaths).toContain('.agents/');
expect(ignorePaths).toContain('.nexus/');
expect(ignorePaths).toContain('AGENTS.md');
```

- [ ] **Step 4: Run config unit tests**

Run:
```bash
npx vitest run tests/unit/config/index.test.ts
```
Expected: all tests pass

- [ ] **Step 5: Run lint**

Run:
```bash
npm run lint
```
Expected: no errors

- [ ] **Step 6: Commit**

```bash
GIT_MASTER=1 git add src/config/index.ts tests/unit/config/index.test.ts
GIT_MASTER=1 git commit -m "feat(config): デフォルトignorePathsに.agents/、.nexus/、AGENTS.mdを追加"
```

---

## Task 4: Phase 3 — Nexus MCP JSON Schema Description 簡潔化

**Files:**
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: `McpServer` tool registration API
- Produces: concise `description` strings for MCP tool schemas

- [ ] **Step 1: Locate tool registration in `src/server/index.ts`**

Run:
```bash
grep -n "server.tool\|description" src/server/index.ts | head -40
```
Expected: tool registration blocks for `hybrid_search`, `grep_search`, etc.

- [ ] **Step 2: Rewrite tool descriptions to be concise and trigger-aligned**

For each tool registration, keep `description` to one short sentence. Examples:
- `hybrid_search`: "Semantic + grep hybrid search for vague or conceptual queries."
- `grep_search`: "Exact string search for symbols, errors, or code fragments."
- `get_context`: "Return a specific line range from a file; prefer partial reads."
- `index_status`: "Check indexing progress and statistics before searching."
- `reindex`: "Manually rebuild the local search index."
- `semantic_search`: "Vector-only semantic search; prefer hybrid_search for most tasks."

Do not change parameter names, types, or tool names. Only shorten descriptions.

- [ ] **Step 3: Verify no type errors**

Run:
```bash
npm run lint
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
GIT_MASTER=1 git add src/server/index.ts
GIT_MASTER=1 git commit -m "refactor(server): MCPツールのdescriptionを簡潔化"
```

---

## Task 5: Phase 4 — 検証シナリオ定義

**Files:**
- Create: `docs/superpowers/plans/2026-07-28-mcp-skills-redesign-verification.md`

**Interfaces:**
- Consumes: none
- Produces: verification scenarios document

- [ ] **Step 1: Write verification scenarios**

Create a markdown document with three manual verification scenarios:
1. **Vague feature search**: User asks "Where is the reindex logic implemented?" Expected path: load `code-search.md` → `hybrid_search` → `get_context` around result lines.
2. **Exact symbol trace**: User asks "Who calls `executeHybridSearch`?" Expected path: load `code-search.md` → `grep_search` for `executeHybridSearch` → `get_context` for call sites.
3. **Structural call-tree request**: User asks "Show me the dependency graph of the search module." Expected path: if `.codegraph/` exists, `codegraph_explore`; otherwise `hybrid_search` for `search/` directory.

Each scenario must include: user input, expected tool sequence, success criteria.

- [ ] **Step 2: Commit**

```bash
GIT_MASTER=1 git add docs/superpowers/plans/2026-07-28-mcp-skills-redesign-verification.md
GIT_MASTER=1 git commit -m "docs: Phase 4 検証シナリオを追加"
```

---

## Task 6: Final Verification & Push

**Files:**
- All modified/created files in this plan

**Interfaces:**
- Consumes: all previous task outputs
- Produces: passing CI checks and pushed branch

- [ ] **Step 1: Run full test suite**

Run:
```bash
npm test
```
Expected: all tests pass

- [ ] **Step 2: Run lint**

Run:
```bash
npm run lint
```
Expected: no errors

- [ ] **Step 3: Review branch log**

Run:
```bash
GIT_MASTER=1 git log --oneline feat/mcp-skills-redesign
```
Expected: at least 5 atomic commits (Tasks 1-5)

- [ ] **Step 4: Push branch**

```bash
GIT_MASTER=1 git push origin feat/mcp-skills-redesign
```

- [ ] **Step 5: Update PR description if necessary**

If the existing PR only contained the design doc, update the PR body to describe that this branch now also contains the implementation (Tasks 1-5).

---

## Self-Review

### Spec coverage

| Spec requirement | Implementing task |
| --- | --- |
| `AGENTS.md` 50行以内軽量化 | Task 1 |
| 決定論的トリガー定義 | Task 1 |
| `.agents/skills/code-search.md` 標準パイプライン | Task 2 |
| One-Call 行動パターン | Task 2 |
| Deferred Loading 手順 | Task 2 |
| `.agents/` 等のインデックス除外 | Task 3 |
| JSON Schema description 簡潔化 | Task 4 |
| Phase 4 検証シナリオ | Task 5 |

### Placeholder scan

No placeholders. All steps include concrete commands and expected outputs.

### Type consistency

Only descriptions are changed in Task 4; no function or type names are modified.
