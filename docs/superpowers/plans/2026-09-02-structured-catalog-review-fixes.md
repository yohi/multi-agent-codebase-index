# Structured Catalog Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. This implementation uses inline execution because subagents are explicitly disallowed.

**Goal:** Make SQLite and in-memory structured catalog implementations preserve generation, epoch, tombstone, import-link, and state invariants while keeping tokenizer budget decisions exact.

**Architecture:** Keep the existing `IStructuredCatalog` boundary and transactional SQLite adapter. Add only the missing declaration-to-import relationship needed to populate `symbol_imports`; cleanup will be performed after each structured-file pointer mutation so active and pending generations remain protected. Keep tokenizer selection exact by retaining whole-context encoding and removing only redundant final work.

**Tech Stack:** TypeScript 5.9, Node.js 24, better-sqlite3, Vitest, js-tiktoken, SQLite WAL transactions.

## Global Constraints

- Do not use subagents.
- Do not commit or push changes.
- Do not expose or add credentials, machine-specific paths, or generated local state.
- Preserve existing active-generation visibility until a successful activation.
- Preserve exact tokenizer budget semantics; do not replace BPE context encoding with additive estimates.
- Follow the repository commands: `npx vitest run <test-file>`, `npm run lint`, and `npx tsc --noEmit`.

---

### Task 1: Lock structured catalog invariants with failing tests

**Files:**
- Modify: `tests/shared/structured-catalog-contract.ts`
- Modify: `tests/unit/storage/sqlite-structured-catalog.test.ts`
- Modify: `tests/unit/storage/structured-catalog-contract.test.ts`

**Interfaces:**
- Consumes: `IStructuredCatalog`, `StructuredGenerationStage`, and existing test fixtures.
- Produces: regression coverage for activation reason order, epoch propagation, removed-symbol tombstones, and tombstone removal on symbol reappearance.

- [ ] **Step 1: Add a contract test for activation validation order**

Use an activation request with stale epoch, stale active generation, and missing pending generation simultaneously, then assert the result is `stale_rebuild_epoch`. Add separate cases for stale active generation and missing generation so both implementations expose the same reason values.

- [ ] **Step 2: Add a contract test for epoch propagation**

Stage a generation with `rebuildEpoch: 7`, activate it with `expectedRebuildEpoch: 7`, and assert activation succeeds. This must fail in the in-memory implementation while its global epoch remains `0`.

- [ ] **Step 3: Add a contract test for removed and re-added symbols**

Activate generation `g1` containing `old`, activate replacement `g2` without `old`, assert `old` has a tombstone, then activate `g3` containing `old` and assert `getTombstone('old')` returns `null` and the tombstone count is zero.

- [ ] **Step 4: Run the focused contract tests and verify the expected red failures**

Run: `npx vitest run tests/unit/storage/sqlite-structured-catalog.test.ts tests/unit/storage/structured-catalog-contract.test.ts`

Expected: existing SQLite tests pass; the new contract assertions fail for in-memory epoch/tombstone behavior and the SQLite re-add tombstone behavior.

### Task 2: Add SQLite generation and import-link regression tests

**Files:**
- Modify: `tests/unit/storage/sqlite-structured-catalog.test.ts`
- Modify: `src/structured/contracts.ts`

**Interfaces:**
- Consumes: `StructuredDeclaration`, `StructuredImport`, and SQLite database path fixtures.
- Produces: a declaration `importBindingIds` relationship and tests proving metadata refresh, stale retirement rejection, unreferenced-generation cleanup, and declaration-keyed import links.

- [ ] **Step 1: Extend the declaration fixture shape with optional import binding IDs**

Add `readonly importBindingIds?: readonly string[]` to `StructuredDeclaration` so parsers that provide verified related imports can associate them without changing existing callers.

- [ ] **Step 2: Add a test for all generation metadata being refreshed**

Stage the same generation ID twice with different schema/parser/file hash/epoch metadata and assert a direct query of `symbol_generations` contains the second values.

- [ ] **Step 3: Add a test for stale retirement being a no-op**

Create an active generation at epoch `4`, call `retireFile` with `rebuildEpoch: 3`, and assert the active generation remains active and no tombstone was inserted.

- [ ] **Step 4: Add a test for stale and pending generation payload cleanup**

Stage and activate `g1`, stage `g2`, replace pending with `g3`, activate `g3`, then query `symbol_generations`, `symbols`, `imports`, and `symbol_imports`; assert only the active generation payload remains.

- [ ] **Step 5: Add a test for declaration-keyed import links**

Stage two declarations that both reference one import binding ID, query `symbol_imports`, and assert two rows keyed by the two declaration symbol IDs exist while no row is keyed by the import binding ID.

- [ ] **Step 6: Run the focused SQLite tests and verify the expected red failures**

Run: `npx vitest run tests/unit/storage/sqlite-structured-catalog.test.ts`

Expected: the new tests fail against the current SQL behavior without failing because of fixture or query errors.

### Task 3: Implement SQLite consistency fixes

**Files:**
- Modify: `src/storage/metadata-store.ts:119-266`

**Interfaces:**
- Consumes: the existing structured catalog interfaces and the `importBindingIds` declaration field.
- Produces: transactional cleanup, consistent CAS reasons, correct tombstone lifecycle, accurate import links, and responsive symbol lookup.

- [ ] **Step 1: Add idempotent SQLite indexes**

Create `symbols_symbol_id_idx` on `symbols(symbol_id)` and `imports_file_generation_idx` on `imports(file_path, generation)` inside the existing initialization SQL.

- [ ] **Step 2: Add one transaction-local cleanup operation for unreferenced generation data**

Delete `symbol_imports`, `imports`, `symbols`, and `symbol_generations` for the target file only when their generation is neither the current active nor pending pointer. Invoke it after stage, activation, pending clear, and retirement pointer mutations.

- [ ] **Step 3: Refresh every generation metadata column on conflict**

Update `schema_version`, `parser_id`, `parser_version`, `content_hash`, and `rebuild_epoch` in the `ON CONFLICT(file_path,generation)` clause.

- [ ] **Step 4: Make activation checks match the in-memory order**

Return `stale_rebuild_epoch`, then `stale_active_generation`, then `missing_generation`, while retaining the existing reason literals.

- [ ] **Step 5: Remove reappeared symbol tombstones during activation**

Delete tombstones whose symbol IDs occur in the newly activated generation before updating the active pointer; keep the existing insert for symbols absent from the replacement generation.

- [ ] **Step 6: Validate retirement epoch before writing tombstones**

Read the persisted rebuild epoch and return without mutation when it differs from `input.rebuildEpoch`; retain the existing active-generation compare-and-swap check.

- [ ] **Step 7: Persist declaration-keyed import relationships**

Insert `symbol_imports` rows by iterating declarations and their `importBindingIds`, resolving each binding ID to its imported source, and never using `StructuredImport.id` as the owning `symbol_id`.

- [ ] **Step 8: Add the async boundary and expand dense structured methods**

Call `await this.asyncBoundary()` before the active symbol query in `resolveSymbol`, and format modified transaction statements and branches as separate statements without changing behavior.

- [ ] **Step 9: Run the focused SQLite tests and verify green**

Run: `npx vitest run tests/unit/storage/sqlite-structured-catalog.test.ts`

Expected: all SQLite structured catalog tests pass.

### Task 4: Implement in-memory parity

**Files:**
- Modify: `tests/unit/storage/in-memory-metadata-store.ts`

**Interfaces:**
- Consumes: `StructuredGenerationStage`, `StructuredGenerationActivation`, and `StructuredFileRetirement`.
- Produces: in-memory behavior matching SQLite for epochs, activation reasons, and tombstones.

- [ ] **Step 1: Update the in-memory global rebuild epoch when staging**

Set the store epoch from `input.rebuildEpoch` in `stageGeneration` so activation and retirement compare against the staged rebuild epoch.

- [ ] **Step 2: Tombstone removed active declarations before replacing the active generation**

Capture the old active generation, set tombstones for declarations absent from the pending replacement, remove tombstones for declarations present in the replacement, then swap active and pending maps.

- [ ] **Step 3: Run the focused contract tests and verify green**

Run: `npx vitest run tests/unit/storage/structured-catalog-contract.test.ts tests/unit/storage/sqlite-structured-catalog.test.ts`

Expected: all structured catalog contract and SQLite tests pass.

### Task 5: Implement reconciliation and tokenizer-safe improvements

**Files:**
- Modify: `src/storage/metadata-store.ts:266`
- Modify: `tests/unit/storage/sqlite-structured-catalog.test.ts`
- Modify: `src/structured/tokenizer.ts`
- Modify: `tests/unit/structured/tokenizer.test.ts`

**Interfaces:**
- Consumes: persisted structured control columns, active/pending pointers, and the existing exact tokenizer API.
- Produces: reconciliation that repairs orphan payloads and active tombstones, state visible through `getStructuredIndexState`, and no redundant final tokenization.

- [ ] **Step 1: Add reconciliation tests**

Seed orphaned generation rows and a tombstone for an active symbol, run `reconcileStructuredState`, assert the orphan rows are removed, the active tombstone is pruned, `repaired` is true, and `prunedTombstones` reports the exact number. Assert active schema version and rebuild state are reflected by `getStructuredIndexState`.

- [ ] **Step 2: Implement reconciliation in one immediate transaction**

Reuse the unreferenced-generation cleanup, remove tombstones for active symbol IDs, derive schema version from consistent active generation metadata, set rebuild state to `building` when pending generations exist and `idle` otherwise, preserve the persisted error code, and return actual repair/prune counts.

- [ ] **Step 3: Add a tokenizer test that guards exact selected imports**

Keep the existing boundary behavior test and assert the returned context and selected IDs are unchanged when a candidate is omitted; this prevents replacing whole-context tokenization with an additive approximation.

- [ ] **Step 4: Derive tokenizer version from package metadata when supported**

Use the installed `js-tiktoken` package metadata for `tokenizerVersion`; if the package export map prevents that import, retain the synchronized literal with an explicit dependency-version test rather than changing budget semantics.

- [ ] **Step 5: Remove only the redundant final token count**

Track the exact token count of the last accepted full context and reuse it for the returned `budget.exceeded` value. Continue encoding each proposed full context so BPE boundary behavior remains unchanged.

- [ ] **Step 6: Run tokenizer tests and record dependency availability**

Run: `npx vitest run tests/unit/structured/tokenizer.test.ts`

Expected: all tokenizer tests pass when `js-tiktoken` is installed; otherwise report the pre-existing missing-package error without modifying dependency manifests.

### Task 6: Run final verification

**Files:**
- Verify: all modified TypeScript and test files from Tasks 1-5

**Interfaces:**
- Consumes: completed structured catalog and tokenizer behavior.
- Produces: verified test, lint, and type-check results with no source changes outside the requested scope.

- [ ] **Step 1: Run the full Vitest suite**

Run: `npx vitest run`

Expected: all tests pass, or any failure is explicitly categorized as an environment/dependency issue.

- [ ] **Step 2: Run lint and type checking**

Run: `npm run lint` and `npx tsc --noEmit`

Expected: no diagnostics attributable to the changed code; unresolved `js-tiktoken` diagnostics remain an environment issue if the dependency is still absent.

- [ ] **Step 3: Inspect changed-file scope without Git operations**

Review the edited file list and confirm no credentials, generated state, or unrelated files were added. Do not commit or push.
