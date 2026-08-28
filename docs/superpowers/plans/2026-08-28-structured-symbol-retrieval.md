# Structured Symbol Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. The requester explicitly prohibits subagents, so do not use `subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add verified, symbol-oriented outline, exact-source, and bounded-context retrieval without changing the existing six MCP tool contracts.

**Architecture:** Keep search chunks in LanceDB and add a versioned logical-symbol catalog to SQLite. Indexing creates a pending structured generation, stages generation-tagged vector rows, verifies both stores, then activates the catalog with compare-and-swap semantics; retrieval resolves only active identities and reads current working-tree bytes once for hash verification and slicing. Dedicated MCP handlers call one `SymbolRetrievalService`; existing semantic, hybrid, grep, and line-oriented retrieval paths remain unchanged.

**Tech Stack:** Node.js >=24, TypeScript 5.9, SQLite via `better-sqlite3`, LanceDB, TypeScript Compiler API, `tree-sitter@0.25.1`, `tree-sitter-python@0.25.0`, `tree-sitter-go@0.25.0`, `js-tiktoken@1.0.21`, Vitest, Prometheus client, `gh stack`.

## Global Constraints

- Use Node.js >=24 and `npm`; `package-lock.json` is authoritative.
- Preserve local-first behavior: do not transmit source code to external services or add a remote dependency for structured retrieval.
- Retain all existing six MCP tools, their input fields, response fields, ranking, and legacy file/line retrieval behavior.
- Add only `get_file_outline`, `get_symbol_source`, and `get_symbol_context`; do not extend `get_context.symbolName` into a structured lookup.
- Store only structured metadata and hashes in SQLite; never persist raw source text in the symbol catalog.
- Compute file, symbol, and import verification hashes from unmodified UTF-8 bytes with SHA-256 lowercase hexadecimal; retain the existing xxhash Merkle contract unchanged.
- Carry original file bytes through structured indexing in one `Uint8Array`; fatal-decode that buffer once for parser and chunk input, and never re-encode a JavaScript string before calculating a structured verification hash.
- Expose public IDs only as `symbol_v1_<base64url-sha256>` with a 43-character, unpadded RFC 4648 digest.
- Require an explicit `reindex({ fullRebuild: true })` to upgrade a legacy index; do not auto-migrate or auto-rebuild a completed legacy index.
- Return no `source` or `context` key for every non-`ok` source/context result; stale data must fail closed.
- Keep TypeScript parsing on the TypeScript Compiler API; use Tree-sitter only for Python and Go structured parsing.
- Pin `tree-sitter@0.25.1`, `tree-sitter-python@0.25.0`, `tree-sitter-go@0.25.0`, and `js-tiktoken@1.0.21` exactly in both `package.json` and `package-lock.json`.
- Use `js-tiktoken/lite` with local `cl100k_base` ranks, no runtime network fetch, no WASM asset, and report tokenizer name and version in context responses.
- Honor existing scope, ignore, traversal, and symlink protections; do not add a structured-only inclusion system.
- Do not add new programming-language support, call graphs, dependency traversal, repository-wide outlines, CLI retrieval commands, automatic grep-hit mapping, AI summaries, or rename/move identity tracking.
- Do not put file paths, symbol IDs, qualified names, signatures, or source content into metric labels or logs.
- Keep CodeGraph responsible for call paths, dependency traversal, blast radius, and impact analysis.
- Use Japanese Conventional Commit messages and create only focused commits on feature branches; do not commit, push, or merge directly on `master`.

## Scope Note

This plan implements [`2026-08-27-structured-symbol-retrieval-design.md`](../specs/2026-08-27-structured-symbol-retrieval-design.md). The additionally requested file `docs/superpowers/specs/2026-08-27-agent-skills-distribution-design.md` does not exist in this repository. Do not infer or implement its unknown requirements. Create a separate plan for it after the source specification is supplied. The agent-guidance changes required by the structured retrieval design remain in scope here.

## File Structure

| Path                                               | Change        | Responsibility                                                                                                                                        |
| -------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/structured/contracts.ts`                      | Create        | Shared structured artifacts, exact byte/text source carrier, catalog rows, statuses, reason codes, and public response types.                         |
| `src/structured/hash.ts`                           | Create        | Exact UTF-8 SHA-256 helpers and fatal UTF-8 decoding.                                                                                                 |
| `src/structured/identity.ts`                       | Create        | Canonical paths, generation IDs, stable symbol IDs, signature normalization helpers, and deterministic sort keys.                                     |
| `src/structured/tokenizer.ts`                      | Create        | Local `cl100k_base` token counter and canonical context construction.                                                                                 |
| `src/structured/utf8-offsets.ts`                   | Create        | TypeScript UTF-16-to-UTF-8 byte-offset map.                                                                                                           |
| `src/structured/retrieval-service.ts`              | Create        | Scope checks, catalog resolution, freshness verification, source slicing, import packing, and response construction.                                  |
| `src/storage/interfaces/structured-catalog.ts`     | Create        | Testable catalog contract for control state, generations, symbols, imports, tombstones, and activation.                                               |
| `src/storage/interfaces/metadata-store.ts`         | Modify        | Compose the structured catalog contract into `IMetadataStore`.                                                                                        |
| `src/storage/metadata-store.ts`                    | Modify        | Idempotent control-schema bootstrap and SQLite implementation of the structured catalog.                                                              |
| `src/indexer/structured-index-coordinator.ts`      | Create        | Per-file stage, verification, activation, cleanup, delete, and reconciliation protocol.                                                               |
| `src/indexer/project-write-coordinator.ts`         | Create        | Project write lock, per-file serialization, full-rebuild barrier, and epoch-aware CAS coordination.                                                   |
| `src/indexer/chunker.ts`                           | Modify        | Attach one `symbolId` to every chunk derived from one exact declaration; leave fallback chunks untagged.                                              |
| `src/indexer/pipeline.ts`                          | Modify        | Load raw bytes once, fatal-decode them, invoke structured staging with watcher/reindex serialization, and preserve active data on failure.            |
| `src/storage/interfaces/vector-store.ts`           | Modify        | Add generation-scoped staging, activation visibility, reconciliation, shadow-table operations, and internal generation metadata for search filtering. |
| `src/storage/vector-store.ts`                      | Modify        | Persist optional `symbolid` and `generationid` only in the structured table and enforce active-generation visibility.                                 |
| `src/plugins/languages/typescript.ts`              | Modify        | Produce exact TypeScript structured artifacts with JSDoc/decorator boundaries, hierarchy, signatures, and binding analysis.                           |
| `src/plugins/languages/python.ts`                  | Modify        | Replace heuristic structured parsing with Tree-sitter Python artifacts.                                                                               |
| `src/plugins/languages/go.ts`                      | Modify        | Replace heuristic structured parsing with Tree-sitter Go artifacts.                                                                                   |
| `src/types/index.ts`                               | Modify        | Add optional `CodeChunk.symbolId`, internal vector generation metadata, and the raw-byte loader contract while preserving public tool fields.         |
| `src/search/semantic.ts`                           | Modify        | Filter structured vector rows by catalog-active generation before returning search results; leave legacy rows unchanged.                              |
| `src/server/factory.ts`                            | Modify        | Construct and inject the raw-byte loader, coordinator, active-generation resolver, and retrieval service per runtime.                                 |
| `src/server/tools/reindex.ts`                      | Modify        | Forward the raw-byte loader through `IIndexPipeline`.                                                                                                 |
| `src/server/path-sanitizer.ts`                     | Modify        | Separate lexical scope validation from existing-file symlink resolution for missing-file structured outcomes.                                         |
| `src/server/tools/registry/schemas-neutral.ts`     | Modify        | Represent string patterns and integer minimum/maximum values.                                                                                         |
| `src/server/tools/registry/definitions.ts`         | Modify        | Register the three structured tool definitions.                                                                                                       |
| `src/server/tools/registry/adapters/v1-adapter.ts` | Modify        | Translate neutral pattern/range rules to Zod v3 validation.                                                                                           |
| `src/server/tools/registry/adapters/v2-adapter.ts` | Modify        | Translate the same rules to JSON Schema and Zod v4 without overriding structured maxima.                                                              |
| `src/server/tools/get-file-outline.ts`             | Create        | Thin handler-facing function for outline requests.                                                                                                    |
| `src/server/tools/get-symbol-source.ts`            | Create        | Thin handler-facing function for exact-source requests.                                                                                               |
| `src/server/tools/get-symbol-context.ts`           | Create        | Thin handler-facing function for bounded-context requests.                                                                                            |
| `src/server/tools/tool-support.ts`                 | Modify        | Wire the new handlers through existing metrics and serialization wrappers.                                                                            |
| `src/server/tools/types.ts`                        | Modify        | Add the injected `SymbolRetrievalService` dependency.                                                                                                 |
| `src/server/tools/index-status.ts`                 | Modify        | Add optional `structuredIndex` status without changing existing fields.                                                                               |
| `src/server/errors.ts`                             | Modify        | Add `NEXUS_INVALID_ARGUMENT` and `NEXUS_REQUEST_CANCELLED` as stable transport errors.                                                                |
| `src/observability/types.ts`                       | Modify        | Add structured parser, retrieval, token, overflow, and catalog hooks with bounded labels.                                                             |
| `src/observability/metrics-collector.ts`           | Modify        | Register and update the structured metrics.                                                                                                           |
| `tests/fixtures/structured/`                       | Create        | TypeScript, Python, and Go source fixtures for exactness, Unicode, imports, and malformed source.                                                     |
| `tests/unit/structured/`                           | Create        | Identity, tokenizer, parser, coordinator, and retrieval-service unit tests.                                                                           |
| `tests/shared/structured-catalog-contract.ts`      | Create        | Shared contract suite for SQLite and in-memory catalog implementations.                                                                               |
| `tests/unit/storage/in-memory-metadata-store.ts`   | Modify        | Implement the structured catalog contract for fast tests.                                                                                             |
| `tests/unit/storage/`                              | Modify/Create | Validate SQLite catalog, Lance schema, legacy compatibility, and failure cleanup.                                                                     |
| `tests/shared/test-helpers.ts`                     | Modify        | Supply exact byte loaders to pipeline tests.                                                                                                          |
| `tests/unit/plugins/languages/`                    | Modify        | Validate TypeScript, Python, and Go structured parser projection and exactness rules.                                                                 |
| `tests/unit/server/tools/`                         | Modify/Create | Validate handler behavior, schema parity, errors, and index status.                                                                                   |
| `tests/unit/search/semantic.test.ts`               | Modify        | Validate that non-active structured generations never reach semantic results.                                                                         |
| `tests/integration/structured-retrieval.test.ts`   | Create        | Verify search/outline/source/context flows against a real runtime.                                                                                    |
| `tests/integration/mcp-protocol.test.ts`           | Modify        | Verify v1/v2 tool registration and input rejection parity.                                                                                            |
| `tests/benchmarks/structured-retrieval.bench.ts`   | Create        | Compare structured scenarios with the existing search/index baseline.                                                                                 |
| `README.md`                                        | Modify        | Document the new agent flow and full-rebuild upgrade requirement.                                                                                     |
| `SPEC.md`                                          | Modify        | Record catalog, generation, retrieval, and responsibility boundaries.                                                                                 |
| `docs/mcp-tools.md`                                | Modify        | Specify all three tool schemas, responses, statuses, and examples.                                                                                    |
| `.agents/skills/code-search.md`                    | Modify        | Prefer structured source/context after symbol-aware semantic or hybrid results.                                                                       |

## Stacked Pull Requests

Create the work as one linear stack, from the foundational contract at the bottom to the documentation-only top layer:

```text
<configured trunk>
  <- feat/structured-foundation
  <- feat/structured-catalog
  <- feat/structured-parsers
  <- feat/structured-indexing
  <- feat/structured-retrieval
  <- docs/structured-retrieval
```

| Stack branch                 | Tasks | Reviewable diff boundary                                                                      |
| ---------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| `feat/structured-foundation` | 1-2   | Pure types, deterministic identity/hash/token accounting, and exact dependency pins.          |
| `feat/structured-catalog`    | 3-4   | SQLite/in-memory catalog and control state, with no production retrieval path yet.            |
| `feat/structured-parsers`    | 5-7   | Parser artifacts and fixtures, independent of Lance activation behavior.                      |
| `feat/structured-indexing`   | 8-9   | Chunk/vector generation visibility, lifecycle coordination, full rebuild, and reconciliation. |
| `feat/structured-retrieval`  | 10-12 | Freshness-honest service, MCP schemas/handlers, compatibility, and surface tests.             |
| `docs/structured-retrieval`  | 13-14 | Metrics, benchmarks, public documentation, and agent workflow guidance.                       |

Before `init`, establish the configured trunk and push remote from the checkout; do not assume a trunk named `master` or a remote named `origin`. Confirm that the `gh-stack` extension is available, GitHub authentication is valid, and stacked PRs are enabled for the repository. Create the stack before the first implementation edit, then submit only the focused layer diffs:

```bash
gh stack init feat/structured-foundation
# Complete and commit Tasks 1-2.
gh stack add feat/structured-catalog
# Complete and commit Tasks 3-4.
gh stack add feat/structured-parsers
# Complete and commit Tasks 5-7.
gh stack add feat/structured-indexing
# Complete and commit Tasks 8-9.
gh stack add feat/structured-retrieval
# Complete and commit Tasks 10-12.
gh stack add docs/structured-retrieval
# Complete and commit Tasks 13-14.
gh stack submit --auto --remote origin
gh stack view --json
```

Use `gh stack rebase --upstack --remote origin` after changing a lower layer, replacing `origin` with the configured push remote. Use `gh stack sync --remote origin` before final review. Do not merge any stack PR; merging remains a human operation.

---

### Task 1: Establish Structured Contracts, Exact Hashing, and Stable Identity

**Stack layer:** `feat/structured-foundation`

**Files:**

- Create: `src/structured/contracts.ts`
- Create: `src/structured/hash.ts`
- Create: `src/structured/identity.ts`
- Modify: `src/types/index.ts:19-29`
- Create: `tests/unit/structured/hash.test.ts`
- Create: `tests/unit/structured/identity.test.ts`

**Interfaces:**

- Produces from `contracts.ts`: `StructuredSource` (canonical file path, language, original `Uint8Array` bytes, and fatal-decoded text), `StructuredParseResult`, `StructuredDeclaration`, `StructuredImport`, `StructuredGeneration`, `StructuredRetrievalStatus`, `StructuredRetrievalReasonCode`, `SymbolPosition`, and `SymbolMetadata`.
- Produces from `hash.ts`: `sha256Hex(bytes)` and `decodeUtf8(bytes)`.
- Produces from `identity.ts`: `createGenerationId(input)` and `createSymbolId(input)`.
- Produces: `CodeChunk.symbolId?: string` and internal `VectorSearchResult.generationId?: string`; no existing public `CodeChunk` property changes type or meaning.

- [ ] **Step 1: Write failing identity and byte-hash tests**

```ts
import { describe, expect, it } from "vitest";

import { createSymbolId } from "../../../src/structured/identity.js";

describe("structured identity", () => {
  const base = {
    filePath: "src/auth.ts",
    qualifiedName: "AuthService.authenticate",
    kind: "method" as const,
    signatureDiscriminator:
      "authenticate ( token : string ) : Promise < User >",
    occurrence: 0,
  };

  it("keeps an ID stable when body and position change", () => {
    expect(createSymbolId(base)).toBe(createSymbolId({ ...base }));
    expect(createSymbolId(base)).toMatch(/^symbol_v1_[A-Za-z0-9_-]{43}$/);
  });

  it("changes IDs for a renamed symbol or changed signature", () => {
    expect(createSymbolId(base)).not.toBe(
      createSymbolId({ ...base, qualifiedName: "AuthService.login" }),
    );
    expect(createSymbolId(base)).not.toBe(
      createSymbolId({
        ...base,
        signatureDiscriminator:
          "authenticate ( token : number ) : Promise < User >",
      }),
    );
  });
});
```

`tests/unit/structured/hash.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decodeUtf8, sha256Hex } from "../../../src/structured/hash.js";

describe("structured byte helpers", () => {
  it("hashes exact UTF-8 bytes rather than normalized text", () => {
    expect(sha256Hex(Buffer.from("cafe\u0301", "utf8"))).not.toBe(
      sha256Hex(Buffer.from("café", "utf8")),
    );
  });

  it("rejects malformed UTF-8 instead of replacing bytes", () => {
    expect(() => decodeUtf8(new Uint8Array([0xc3, 0x28]))).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails because the structured module is absent**

Run: `npx vitest run tests/unit/structured/hash.test.ts tests/unit/structured/identity.test.ts`

Expected: FAIL with module-resolution errors for `src/structured/hash.js` and `src/structured/identity.js`.

- [ ] **Step 3: Add the canonical domain contract and deterministic helpers**

`src/structured/hash.ts`:

```ts
import { createHash } from "node:crypto";

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export const decodeUtf8 = (bytes: Uint8Array): string =>
  utf8Decoder.decode(bytes);
```

`src/structured/identity.ts`:

```ts
import { createHash } from "node:crypto";

export const createGenerationId = (input: {
  schemaVersion: 1;
  parserId: string;
  parserVersion: string;
  contentHash: string;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        input.schemaVersion,
        input.parserId,
        input.parserVersion,
        input.contentHash,
      ]),
      "utf8",
    )
    .digest("base64url");

export const createSymbolId = (input: {
  filePath: string;
  qualifiedName: string;
  kind: string;
  signatureDiscriminator: string;
  occurrence: number;
}): string =>
  `symbol_v1_${createHash("sha256")
    .update(
      JSON.stringify([
        1,
        input.filePath,
        input.qualifiedName,
        input.kind,
        input.signatureDiscriminator,
        input.occurrence,
      ]),
      "utf8",
    )
    .digest("base64url")}`;
```

Define the three legal file-level state pairs in `contracts.ts`: `exact/complete`, `degraded/partial`, and `unsupported/none`. Encode all other combinations as an internal invariant failure. Define reason codes and failure payloads exactly as the design specifies, require `reasonCode` on every non-`ok` result, and make `retrievability` public only as `'exact'`.

Add `symbolId?: string` to `CodeChunk` without changing `id`, `hash`, line fields, or existing response types. Keep SHA-256 helpers outside `src/indexer/hash.ts` so the Merkle tree remains on xxhash.

Define `StructuredSource` so structured parsers always receive the exact byte buffer and its one fatal-decoded text view. Add tests that malformed UTF-8 is rejected before parsing and that hash input remains the unmodified buffer.

- [ ] **Step 4: Run the focused test and the existing chunker test**

Run: `npx vitest run tests/unit/structured/hash.test.ts tests/unit/structured/identity.test.ts tests/unit/indexer/chunker.test.ts`

Expected: PASS; existing chunks without a structured artifact still have no `symbolId`.

- [ ] **Step 5: Commit the foundation contract**

```bash
git add src/structured/contracts.ts src/structured/hash.ts src/structured/identity.ts src/types/index.ts tests/unit/structured/hash.test.ts tests/unit/structured/identity.test.ts
git commit -m "feat: structured symbol 契約を追加"
```

### Task 2: Pin the Local Tokenizer and Canonical Context Algorithm

**Stack layer:** `feat/structured-foundation`

**Files:**

- Modify: `package.json:54-75`
- Modify: `package-lock.json`
- Create: `src/structured/tokenizer.ts`
- Create: `tests/unit/structured/tokenizer.test.ts`

**Interfaces:**

- Consumes: exact source strings and source-order import candidates materialized in memory at retrieval time; persisted catalog rows never carry source text.
- Produces: `TokenCounter.count(text: string): number`, `buildCanonicalContext(importSources, symbolSource)`, and `packRelatedImports(input): PackedContext`.

- [ ] **Step 1: Write failing tests for canonical text, overflow, and import-unit packing**

```ts
import { describe, expect, it } from "vitest";

import {
  buildCanonicalContext,
  packRelatedImports,
} from "../../../src/structured/tokenizer.js";

describe("canonical structured context", () => {
  it("joins imports and the complete symbol with exactly one blank line", () => {
    expect(
      buildCanonicalContext(
        ['import { User } from "./user.js";'],
        "export const getUser = () => null;",
      ),
    ).toBe(
      'import { User } from "./user.js";\n\nexport const getUser = () => null;',
    );
  });

  it("keeps a budget-overflowing symbol complete and omits all imports", () => {
    const result = packRelatedImports({
      symbolSource: "very long complete symbol",
      tokenBudget: 1,
      imports: [
        {
          id: "one",
          rawSource: 'import { User } from "./user.js";',
          startByte: 0,
        },
      ],
    });
    expect(result.context).toBe("very long complete symbol");
    expect(result.budget.exceeded).toBe(true);
    expect(result.budget.omittedForBudget).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify the tokenizer module is missing**

Run: `npx vitest run tests/unit/structured/tokenizer.test.ts`

Expected: FAIL with a module-resolution error for `src/structured/tokenizer.js`.

- [ ] **Step 3: Install exact runtime dependencies and implement the fixed counter**

Run: `npm install --save-exact tree-sitter@0.25.1 tree-sitter-python@0.25.0 tree-sitter-go@0.25.0 js-tiktoken@1.0.21`

Implement the counter with the local ranks only:

```ts
import { Tiktoken } from "js-tiktoken/lite";
import cl100kBase from "js-tiktoken/ranks/cl100k_base";

const encoder = new Tiktoken(cl100kBase);

export const tokenCounter = {
  tokenizer: "cl100k_base" as const,
  tokenizerVersion: "js-tiktoken@1.0.21" as const,
  count: (text: string): number => encoder.encode(text).length,
};

export const buildCanonicalContext = (
  imports: readonly string[],
  symbolSource: string,
): string => {
  const importText = imports.join("\n");
  return importText.length > 0
    ? `${importText}\n\n${symbolSource}`
    : symbolSource;
};
```

For each source-order candidate, recompute tokens for the entire candidate canonical context. If a candidate does not fit, count it as `omittedForBudget` and keep evaluating later candidates. Deduplicate repeated import declarations by their catalog ID. Do not truncate an import declaration or transform any raw source text.

- [ ] **Step 4: Run focused tests and verify lockfile pins**

Run: `npx vitest run tests/unit/structured/tokenizer.test.ts && npm ls tree-sitter tree-sitter-python tree-sitter-go js-tiktoken`

Expected: PASS; all four packages resolve to the exact versions in the global constraints.

- [ ] **Step 5: Commit the deterministic tokenizer layer**

```bash
git add package.json package-lock.json src/structured/tokenizer.ts tests/unit/structured/tokenizer.test.ts
git commit -m "feat: structured context のトークン計測を追加"
```

### Task 3: Define the Structured Catalog Contract and In-Memory Test Double

**Stack layer:** `feat/structured-catalog`

**Files:**

- Create: `src/storage/interfaces/structured-catalog.ts`
- Modify: `src/storage/interfaces/metadata-store.ts:26-65`
- Modify: `tests/unit/storage/in-memory-metadata-store.ts`
- Create: `tests/shared/structured-catalog-contract.ts`
- Create: `tests/unit/storage/structured-catalog-contract.test.ts`

**Interfaces:**

- Consumes: `StructuredGeneration`, `StructuredDeclaration`, `StructuredImport`, and identity types from `src/structured/contracts.ts`.
- Produces: `IStructuredCatalog` methods `bootstrapStructuredSchema()`, `getStructuredIndexState()`, `stageGeneration(input)`, `activateGeneration(input)`, `clearPendingGeneration(input)`, `retireFile(input)`, `resolveFile(filePath)`, `getActiveGenerationMap(filePaths)`, `resolveSymbol(symbolId)`, `getPendingSymbol(symbolId)`, `getTombstone(symbolId)`, `getStructuredCounts()`, and `reconcileStructuredState()`.
- Requires: `clearPendingGeneration` to compare `filePath`, expected active generation, expected pending generation, and rebuild epoch atomically, so a stale cleanup cannot remove a newer pending generation.

- [ ] **Step 1: Write one reusable contract suite before adding SQLite SQL**

```ts
export const structuredCatalogContract = (
  createStore: () => Promise<IStructuredCatalog>,
) => {
  describe("structured catalog contract", () => {
    it("keeps active symbols visible while a replacement generation is pending", async () => {
      const store = await createStore();
      await store.stageGeneration(firstGeneration);
      await store.activateGeneration(firstActivation);
      await store.stageGeneration(replacementGeneration);

      expect((await store.resolveSymbol(firstSymbol.symbolId)).kind).toBe(
        "active",
      );
      expect(
        (await store.getPendingSymbol(replacementSymbol.symbolId)).kind,
      ).toBe("pending");
    });
  });
};
```

Add cases for activation CAS rejection, retirement tombstones, tombstone removal on reappearance, deleted-file retirement, stale pending cleanup, and a fully rebuilt catalog pruning historical tombstones only after successful activation. Assert that a clear using a stale pending generation or epoch returns `{ cleared: false }` and leaves a newer pending generation unchanged.

- [ ] **Step 2: Run the contract test to verify the new contract is absent**

Run: `npx vitest run tests/unit/storage/structured-catalog-contract.test.ts`

Expected: FAIL with a module-resolution error for `src/storage/interfaces/structured-catalog.js`.

- [ ] **Step 3: Define a storage-neutral catalog API and implement it in memory**

```ts
export interface StructuredPendingClear {
  filePath: string;
  expectedActiveGeneration: string | null;
  expectedPendingGeneration: string;
  expectedRebuildEpoch: number;
}

export interface IStructuredCatalog {
  bootstrapStructuredSchema(): Promise<void>;
  getStructuredIndexState(): Promise<StructuredIndexState>;
  stageGeneration(input: StructuredGenerationStage): Promise<void>;
  activateGeneration(
    input: StructuredGenerationActivation,
  ): Promise<StructuredActivationResult>;
  clearPendingGeneration(
    input: StructuredPendingClear,
  ): Promise<{ cleared: boolean }>;
  retireFile(input: StructuredFileRetirement): Promise<void>;
  resolveFile(filePath: string): Promise<StructuredFileResolution>;
  getActiveGenerationMap(
    filePaths: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  resolveSymbol(symbolId: string): Promise<StructuredSymbolResolution>;
  getPendingSymbol(
    symbolId: string,
  ): Promise<StructuredPendingSymbolResolution>;
  getTombstone(symbolId: string): Promise<StructuredTombstone | null>;
  getStructuredCounts(): Promise<StructuredIndexCounts>;
  reconcileStructuredState(): Promise<StructuredReconciliationResult>;
}
```

Compose this contract into `IMetadataStore` rather than creating a second SQLite connection. Extend the in-memory implementation with maps keyed by `filePath`, `[filePath, generation, symbolId]`, and `symbolId`, and preserve the same pending/active/tombstone precedence as the SQLite implementation. `clearPendingGeneration` returns `{ cleared: false }` without changing either pointer when any expected value no longer matches. Contract-test `getActiveGenerationMap` with mixed active, pending, and missing files so search can validate a candidate set in one catalog read.

- [ ] **Step 4: Run the contract against the in-memory store**

Run: `npx vitest run tests/unit/storage/structured-catalog-contract.test.ts`

Expected: PASS; the test double exercises exactly the public catalog behavior and does not store raw declaration source.

- [ ] **Step 5: Commit the catalog boundary**

```bash
git add src/storage/interfaces/structured-catalog.ts src/storage/interfaces/metadata-store.ts tests/unit/storage/in-memory-metadata-store.ts tests/shared/structured-catalog-contract.ts tests/unit/storage/structured-catalog-contract.test.ts
git commit -m "feat: structured symbol catalog 契約を追加"
```

### Task 4: Implement SQLite Catalog Tables and Structured Control State

**Stack layer:** `feat/structured-catalog`

**Files:**

- Modify: `src/storage/metadata-store.ts:52-111`
- Modify: `tests/unit/storage/metadata-store.test.ts`
- Create: `tests/unit/storage/sqlite-structured-catalog.test.ts`

**Interfaces:**

- Consumes: the `IStructuredCatalog` contract from Task 3.
- Produces: SQLite-backed `structured_files`, `symbol_generations`, `symbols`, `imports`, `symbol_imports`, `symbol_tombstones`, structured control columns in `index_stats`, and transactionally correct catalog methods.

- [ ] **Step 1: Add failing SQLite tests for bootstrap and activation atomicity**

```ts
it("bootstraps empty structured tables without migrating an existing search index", async () => {
  await store.initialize();
  expect((await store.getStructuredIndexState()).schemaVersion).toBeNull();
  expect(await store.getIndexStats()).toMatchObject({ id: "primary" });
});

it("activates a staged generation and records disappeared symbols as tombstones in one transaction", async () => {
  await stageAndActivate(store, firstGeneration);
  await store.stageGeneration(replacementWithoutOldSymbol);
  await store.activateGeneration(replacementActivation);

  expect(await store.getTombstone(firstSymbol.symbolId)).toMatchObject({
    symbolId: firstSymbol.symbolId,
  });
  expect((await store.resolveSymbol(replacementSymbol.symbolId)).kind).toBe(
    "active",
  );
});
```

- [ ] **Step 2: Run the SQLite test to verify the tables and methods do not exist**

Run: `npx vitest run tests/unit/storage/sqlite-structured-catalog.test.ts`

Expected: FAIL because `SqliteMetadataStore` does not implement structured catalog methods.

- [ ] **Step 3: Add idempotent DDL and transaction-backed catalog methods**

Use `CREATE TABLE IF NOT EXISTS` only for control-schema bootstrap. Store `structured_schema_version`, `structured_rebuild_state`, `structured_rebuild_epoch`, and `structured_last_error_code` in `index_stats` through idempotent column additions. Create catalog tables with these keys and constraints:

```sql
CREATE TABLE IF NOT EXISTS structured_files (
  file_path TEXT PRIMARY KEY,
  active_generation TEXT,
  pending_generation TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
  file_path TEXT NOT NULL,
  generation TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  PRIMARY KEY (file_path, generation, symbol_id)
);
```

Add all columns required by the approved design, including parser metadata, line ranges, parent IDs, import completeness, diagnostics JSON, and tombstone timestamps. Use immediate SQLite transactions for stage/activate/retire/clear operations. Activation must compare the expected active generation, expected pending generation, and rebuild epoch before changing pointers. `clearPendingGeneration` must compare the same values and return `{ cleared: false }` without changing pointers on a CAS conflict. Activation must retire disappearing IDs and clear the pending pointer atomically. Do not write source text to any table.

- [ ] **Step 4: Run the contract against SQLite and existing metadata tests**

Run: `npx vitest run tests/unit/storage/sqlite-structured-catalog.test.ts tests/unit/storage/metadata-store.test.ts`

Expected: PASS; the existing Merkle, DLQ, embedding-cache, and index-stat tests remain unchanged.

- [ ] **Step 5: Commit SQLite catalog storage**

```bash
git add src/storage/metadata-store.ts tests/unit/storage/metadata-store.test.ts tests/unit/storage/sqlite-structured-catalog.test.ts
git commit -m "feat: SQLite にstructured catalogを保存"
```

### Task 5: Produce Exact TypeScript Structured Artifacts

**Stack layer:** `feat/structured-parsers`

**Files:**

- Create: `src/structured/utf8-offsets.ts`
- Modify: `src/plugins/languages/typescript.ts:32-170`
- Modify: `src/types/index.ts:156-163`
- Create: `tests/fixtures/structured/typescript/exactness.ts`
- Modify: `tests/unit/plugins/languages/typescript.test.ts`
- Create: `tests/unit/structured/typescript-parser.test.ts`

**Interfaces:**

- Consumes: `StructuredLanguageParser.parseStructured(source: StructuredSource): Promise<StructuredParseResult>`.
- Produces: TypeScript `StructuredDeclaration` and `StructuredImport` values with exact UTF-8 byte ranges, qualified names, signatures, parent relationships, import binding IDs, and coverage diagnostics.

- [ ] **Step 1: Add failing fixture tests for TypeScript boundaries and identity inputs**

```ts
it("includes attached JSDoc, decorators, and modifiers but excludes unattached comments", async () => {
  const result = await parseFixture(
    "tests/fixtures/structured/typescript/exactness.ts",
  );
  const method = result.declarations.find(
    (item) => item.qualifiedName === "Service.fetch",
  )!;

  expect(method.rawSource).toStartWith(
    "/** Fetches one user. */\n  @trace()\n  public async fetch",
  );
  expect(method.rawSource).not.toContain("unattached comment");
  expect(method.position.startByte).toBe(
    Buffer.byteLength(fixtureBeforeMethod, "utf8"),
  );
});

it("uses distinct IDs for overloads and default/anonymous declarations", async () => {
  const result = await parseFixture(
    "tests/fixtures/structured/typescript/exactness.ts",
  );
  expect(new Set(result.declarations.map((item) => item.symbolId)).size).toBe(
    result.declarations.length,
  );
});
```

Include fixtures for namespace/class/member nesting, getter/setter/constructor, property, type alias, enum, single-identifier variable/constant, overload signatures and implementation, CJK/emoji source, shadowed imports, namespace aliases, and a parse error yielding `degraded/partial`.

- [ ] **Step 2: Run the parser tests to verify the structured parser API is absent**

Run: `npx vitest run tests/unit/structured/typescript-parser.test.ts tests/unit/plugins/languages/typescript.test.ts`

Expected: FAIL because no language plugin exposes `createStructuredParser`.

- [ ] **Step 3: Add a backward-compatible structured parser path**

```ts
export interface StructuredLanguageParser {
  parseStructured(source: StructuredSource): Promise<StructuredParseResult>;
}

export interface LanguagePlugin {
  readonly languageId: string;
  readonly fileExtensions: string[];
  supports(filePath: string): boolean;
  createParser(): Promise<{
    parse(file: FileToChunk): Promise<ParsedSourceFile>;
  }>;
  createStructuredParser?(): Promise<StructuredLanguageParser>;
}
```

Build a UTF-16-to-UTF-8 offset table once per `StructuredSource`. Parse its fatal-decoded text, but calculate every file, declaration, and import hash from its original bytes. Derive declaration starts from attached JSDoc, decorator, and modifier starts and declaration ends from `node.end`. Tokenize declaration headers to build a display signature and signature discriminator: remove trivia/comments/decorators, normalize identifier tokens to NFC, preserve literal raw text, include only the approved type syntax, and exclude bodies and variable initializers. Do not issue public IDs for multi-declarator or destructuring variables.

Set `exact/complete` only when compiler diagnostics do not intersect a declaration or its qualification ancestor chain. Otherwise keep exact declarations in a `degraded/partial` result and omit IDs for uncertain declarations. Resolve related import bindings lexically and downgrade import completeness to `partial` for any ambiguity or shadowed binding.

- [ ] **Step 4: Run TypeScript parser and identity tests**

Run: `npx vitest run tests/unit/structured/typescript-parser.test.ts tests/unit/plugins/languages/typescript.test.ts tests/unit/structured/identity.test.ts`

Expected: PASS; legacy `parse()` behavior remains available to `Chunker`; parser artifacts may hold source only while indexing, while persistence-facing catalog projections contain no raw source.

- [ ] **Step 5: Commit TypeScript structured parsing**

```bash
git add src/structured/utf8-offsets.ts src/plugins/languages/typescript.ts src/types/index.ts tests/fixtures/structured/typescript/exactness.ts tests/unit/plugins/languages/typescript.test.ts tests/unit/structured/typescript-parser.test.ts
git commit -m "feat: TypeScript structured parserを追加"
```

### Task 6: Replace Python Heuristics with Tree-sitter Structured Parsing

**Stack layer:** `feat/structured-parsers`

**Files:**

- Modify: `src/plugins/languages/python.ts`
- Create: `tests/fixtures/structured/python/exactness.py`
- Modify: `tests/unit/plugins/languages/python.test.ts`
- Modify: `tests/unit/plugins/languages/python_bugs.test.ts`
- Create: `tests/unit/structured/python-parser.test.ts`

**Interfaces:**

- Consumes: Task 5's optional `LanguagePlugin.createStructuredParser()` API and Task 1 contracts.
- Produces: Tree-sitter Python artifacts for top-level classes/functions/async functions and class methods only.

- [ ] **Step 1: Write failing Tree-sitter Python fixture tests**

```ts
it("includes only same-indent decorators and excludes preceding hash comments", async () => {
  const result = await parsePythonFixture(
    "tests/fixtures/structured/python/exactness.py",
  );
  const decorated = result.declarations.find(
    (item) => item.qualifiedName === "Service.fetch",
  )!;

  expect(decorated.rawSource).toStartWith("@cache\n    async def fetch");
  expect(decorated.rawSource).not.toContain("# unrelated");
});

it("does not create exact symbols for nested functions or destructuring assignments", async () => {
  const result = await parsePythonFixture(
    "tests/fixtures/structured/python/exactness.py",
  );
  expect(result.declarations.map((item) => item.qualifiedName)).not.toContain(
    "outer.inner",
  );
  expect(result.declarations.map((item) => item.name)).not.toContain("left");
});
```

Add malformed syntax, PEP 695 type parameters, docstrings, aliases, shadowing, star/dot imports, Unicode offsets, and import-completeness fixtures.

- [ ] **Step 2: Run the new tests to establish the heuristic parser is insufficient**

Run: `npx vitest run tests/unit/structured/python-parser.test.ts tests/unit/plugins/languages/python.test.ts tests/unit/plugins/languages/python_bugs.test.ts`

Expected: FAIL on byte offsets, malformed-file coverage, or exact source boundaries.

- [ ] **Step 3: Implement the Tree-sitter Python artifact parser**

```ts
import Parser from "tree-sitter";
import Python from "tree-sitter-python";

const parser = new Parser();
parser.setLanguage(Python);
const tree = parser.parse(source.text);
```

Walk only `class_definition`, `function_definition`, and `async_function_definition` nodes that satisfy the approved scope. Include consecutive decorator nodes at the same indentation level immediately attached to the declaration. Use Tree-sitter byte offsets directly, source-order hierarchy for qualified names, and fatal UTF-8 decoding for all raw source slices. A node or required ancestor containing `ERROR` or `MISSING` is not exact; emit it only as a partial diagnostic, never with a public ID.

Project exact declarations back to the legacy `ParsedSourceFile` API so existing chunking continues to work. Keep the existing fixed-line fallback path when Tree-sitter is unavailable or parsing fails.

- [ ] **Step 4: Run Python parser tests**

Run: `npx vitest run tests/unit/structured/python-parser.test.ts tests/unit/plugins/languages/python.test.ts tests/unit/plugins/languages/python_bugs.test.ts`

Expected: PASS; the same file can return `degraded/partial` while still exposing independently exact declarations.

- [ ] **Step 5: Commit Tree-sitter Python support**

```bash
git add src/plugins/languages/python.ts tests/fixtures/structured/python/exactness.py tests/unit/plugins/languages/python.test.ts tests/unit/plugins/languages/python_bugs.test.ts tests/unit/structured/python-parser.test.ts
git commit -m "feat: Python structured parserをTree-sitter化"
```

### Task 7: Replace Go Heuristics with Tree-sitter Structured Parsing

**Stack layer:** `feat/structured-parsers`

**Files:**

- Modify: `src/plugins/languages/go.ts`
- Create: `tests/fixtures/structured/go/exactness.go`
- Modify: `tests/unit/plugins/languages/go.test.ts`
- Modify: `tests/unit/plugins/languages/go_bugs.test.ts`
- Create: `tests/unit/structured/go-parser.test.ts`

**Interfaces:**

- Consumes: Task 5's structured parser API and Task 1 identity helper.
- Produces: Tree-sitter Go artifacts for type declarations, functions, receiver methods, and resolvable interface method specifications.

- [ ] **Step 1: Write failing Go identity and comment-boundary tests**

```ts
it("uses owner-qualified interface methods with distinct public IDs", async () => {
  const result = await parseGoFixture(
    "tests/fixtures/structured/go/exactness.go",
  );
  const reader = result.declarations.find(
    (item) => item.qualifiedName === "Reader.Read",
  )!;
  const writer = result.declarations.find(
    (item) => item.qualifiedName === "Writer.Read",
  )!;

  expect(reader.symbolId).not.toBe(writer.symbolId);
  expect(reader.parentKey).toBe("Reader");
  expect(writer.parentKey).toBe("Writer");
});

it("includes adjacent Go doc comments and directives but excludes comments after a blank line", async () => {
  const result = await parseGoFixture(
    "tests/fixtures/structured/go/exactness.go",
  );
  expect(
    result.declarations.find((item) => item.name === "Open")!.rawSource,
  ).toContain("//go:noinline");
});
```

Include `Reader.Read` and `Writer.Read` with identical signatures, receiver methods whose type is in the same and a different file, grouped types, embedded interfaces, directives, malformed syntax, aliases, and implicit package references.

- [ ] **Step 2: Run the test to show the line-scanning parser cannot meet the contract**

Run: `npx vitest run tests/unit/structured/go-parser.test.ts tests/unit/plugins/languages/go.test.ts tests/unit/plugins/languages/go_bugs.test.ts`

Expected: FAIL on owner-qualified interface methods, byte ranges, or exactness classification.

- [ ] **Step 3: Implement Tree-sitter Go extraction and conservative import analysis**

```ts
import Parser from "tree-sitter";
import Go from "tree-sitter-go";

const parser = new Parser();
parser.setLanguage(Go);
const tree = parser.parse(source.text);
```

Extract only standalone type declarations, functions, receiver methods, and interface method specifications with a resolvable owning interface in the same file. Prefix source with an immediately adjacent Go doc-comment group and any `//go:` directive in that group. Do not produce exact symbols for grouped type specs, embedded interface elements, or interface methods without an owning interface. Resolve a receiver parent only within the same file; retain the receiver in the qualified name even when the parent ID is null. Treat implicit Go package names and ambiguous import references as unavailable or partial rather than guessed.

- [ ] **Step 4: Run Go parser tests and the shared identity suite**

Run: `npx vitest run tests/unit/structured/go-parser.test.ts tests/unit/plugins/languages/go.test.ts tests/unit/plugins/languages/go_bugs.test.ts tests/unit/structured/identity.test.ts`

Expected: PASS; same-signature `Reader.Read` and `Writer.Read` have distinct qualified names and IDs.

- [ ] **Step 5: Commit Tree-sitter Go support**

```bash
git add src/plugins/languages/go.ts tests/fixtures/structured/go/exactness.go tests/unit/plugins/languages/go.test.ts tests/unit/plugins/languages/go_bugs.test.ts tests/unit/structured/go-parser.test.ts
git commit -m "feat: Go structured parserをTree-sitter化"
```

### Task 8: Tag Search Chunks and Stage Generation-Aware Vector Rows

**Stack layer:** `feat/structured-indexing`

**Files:**

- Modify: `src/indexer/chunker.ts:23-79`
- Modify: `src/storage/interfaces/vector-store.ts:40-58`
- Modify: `src/storage/vector-store.ts:374-598`
- Modify: `src/search/semantic.ts`
- Modify: `src/server/factory.ts`
- Modify: `tests/unit/storage/in-memory-vector-store.ts`
- Modify: `tests/shared/vector-store-contract.ts`
- Create: `tests/unit/storage/structured-vector-store.test.ts`
- Modify: `tests/unit/indexer/chunker.test.ts`
- Modify: `tests/unit/search/semantic.test.ts`
- Modify: `tests/unit/server/factory.test.ts`

**Interfaces:**

- Consumes: exact `StructuredParseResult` from Tasks 5-7 and active generation metadata from Task 3.
- Produces: every structured declaration chunk carries `CodeChunk.symbolId`; fixed-line fallback chunks omit `symbolId`; `IVectorStore` adds generation-stage, generation-visibility, generation-cleanup, shadow-table methods, and internal generation metadata; `SemanticSearch` batch-validates structured rows against catalog-active generations.

- [ ] **Step 1: Write failing chunk and vector visibility tests**

```ts
it("assigns the same ID to every chunk split from one declaration", async () => {
  const chunks = await chunker.chunkStructuredFile(
    file,
    artifactWithLongFunction,
  );
  expect(new Set(chunks.map((chunk) => chunk.symbolId))).toEqual(
    new Set([artifactWithLongFunction.declarations[0]!.symbolId]),
  );
});

it("never returns pending rows from search", async () => {
  await store.stageGenerationChunks(pendingRows);
  expect(await store.search(vector, 10)).toEqual([]);
});
```

Add a semantic-search test with an active-visibility structured row whose `(filePath, generationId)` is absent from the catalog active-generation map. Assert that the structured row is omitted while otherwise eligible legacy rows retain their relative score order.

- [ ] **Step 2: Run the focused tests to verify no structured-vector API exists**

Run: `npx vitest run tests/unit/indexer/chunker.test.ts tests/unit/storage/structured-vector-store.test.ts`

Expected: FAIL because `chunkStructuredFile` and generation staging methods are absent.

- [ ] **Step 3: Add opt-in structured chunking and a new Lance table schema**

Add a `Chunker.chunkStructuredFile(file, artifact)` method that uses the existing split algorithm and preserves existing chunk IDs, content, line range, and hash behavior while copying the declaration's stable `symbolId` to every resulting chunk. Keep `chunkFiles()` and `chunkByFixedLines()` unchanged for unsupported, failed, and uncertain parser output.

Add a structured Lance row schema containing `symbolid`, `generationid`, and `visibility` in addition to existing chunk fields. Stage rows as `visibility = 'pending'`, and have vector search return the generation ID only as internal result metadata. Search the structured table only for active-visibility rows. Inject the catalog batch resolver into `SemanticSearch`, then discard every structured row whose `(filePath, generationId)` does not match the catalog's active generation; do not make `IVectorStore` depend on SQLite metadata. Keep legacy tables on their existing column set; do not write a `symbolId` column into a legacy index before an explicit full rebuild.

```ts
export interface IVectorStore {
  stageGenerationChunks(input: StructuredVectorStage): Promise<void>;
  activateGenerationRows(input: StructuredVectorActivation): Promise<void>;
  removeGenerationRows(input: StructuredVectorCleanup): Promise<void>;
  beginStructuredShadowTable(): Promise<void>;
  swapStructuredShadowTable(): Promise<void>;
  reconcileStructuredRows(input: StructuredVectorReconciliation): Promise<void>;
  // Existing methods remain unchanged.
}
```

- [ ] **Step 4: Run vector contracts and chunker regression tests**

Run: `npx vitest run tests/unit/storage/structured-vector-store.test.ts tests/integration/vector-store.test.ts tests/unit/storage/in-memory-vector-store.test.ts tests/unit/indexer/chunker.test.ts tests/unit/search/semantic.test.ts tests/unit/server/factory.test.ts`

Expected: PASS; existing vectors retain their search behavior and fallback chunks have no public symbol identity.

- [ ] **Step 5: Commit generation-aware vector staging**

```bash
git add src/indexer/chunker.ts src/storage/interfaces/vector-store.ts src/storage/vector-store.ts src/search/semantic.ts src/server/factory.ts tests/unit/storage/in-memory-vector-store.ts tests/shared/vector-store-contract.ts tests/unit/storage/structured-vector-store.test.ts tests/unit/indexer/chunker.test.ts tests/unit/search/semantic.test.ts tests/unit/server/factory.test.ts
git commit -m "feat: 検索chunkにstructured generationを関連付け"
```

### Task 9: Coordinate Per-File Stage, Activation, Delete, and Incremental Recovery

**Stack layer:** `feat/structured-indexing`

**Files:**

- Create: `src/indexer/project-write-coordinator.ts`
- Create: `src/indexer/structured-index-coordinator.ts`
- Modify: `src/indexer/pipeline.ts:65-112,207-540`
- Modify: `src/types/index.ts:60-76,315-328`
- Modify: `src/server/factory.ts:481-554`
- Modify: `src/server/tools/reindex.ts:1-15`
- Create: `tests/unit/structured/structured-index-coordinator.test.ts`
- Modify: `tests/shared/test-helpers.ts`
- Modify: `tests/unit/indexer/pipeline-completion.test.ts`
- Modify: `tests/unit/indexer/pipeline-windowed.test.ts`
- Modify: `tests/unit/indexer/rename-detection.test.ts`

**Interfaces:**

- Consumes: parser artifacts, catalog methods, vector stage methods, and existing embedding cache behavior.
- Produces: one `LoadedSource` flow carrying original bytes plus fatal-decoded text, `ProjectWriteCoordinator.runIncremental(filePath, operation)`, `ProjectWriteCoordinator.runFullRebuild(operation)`, `StructuredIndexCoordinator.stageFile(input)`, `activateFile(input)`, `deleteFile(input)`, and `reconcile()`.

- [ ] **Step 1: Write failing failure-injection and pending-precedence tests**

```ts
it("keeps the active catalog and vectors visible when Lance staging fails mid-batch", async () => {
  await indexer.index(firstFileVersion);
  vectorStore.failOnBatch(2);

  await expect(indexer.index(secondFileVersion)).rejects.toThrow(
    "batch 2 failed",
  );
  expect(await catalog.resolveSymbol(firstSymbol.symbolId)).toMatchObject({
    kind: "active",
  });
  expect(await catalog.resolveFile("src/auth.ts")).toMatchObject({
    pendingGeneration: null,
  });
  // Failed-generation Lance rows must be deleted or hidden from search.
  // The prior active generation remains visible, but no symbol IDs from the
  // failed pending generation may surface in vector search results.
  const searchResults = await vectorStore.search(vector, 100);
  const visibleFailedSymbolIds = new Set(
    searchResults
      .map((r) => r.chunk.symbolId)
      .filter((id): id is string => id !== undefined && id !== firstSymbol.symbolId),
  );
  expect(visibleFailedSymbolIds.size).toBe(0);
  expect(await vectorStore.search(vector, 10)).toContainEqual(
    expect.objectContaining({
      chunk: expect.objectContaining({ symbolId: firstSymbol.symbolId }),
    }),
  );
});

it("returns index_incomplete for a pending file instead of stale source", async () => {
  await coordinator.stageFile(replacement);
  expect(await service.getSymbolSource({ symbolId: stableId })).toMatchObject({
    status: "index_incomplete",
    reasonCode: "INDEX_PENDING_GENERATION",
  });
});
```

- [ ] **Step 2: Run the coordinator test to prove the lifecycle is absent**

Run: `npx vitest run tests/unit/structured/structured-index-coordinator.test.ts`

Expected: FAIL with module-resolution errors for the coordinator and missing generation APIs.

- [ ] **Step 3: Implement the pending-to-active per-file protocol**

Implement this fixed sequence under a project write lock and a per-file lock:

```text
read bytes once -> fatal-decode once -> parse artifact -> assign IDs -> SQLite stage pending
-> build chunks -> stage pending Lance rows -> verify catalog/chunk/file hashes
-> mark matching Lance rows active -> SQLite CAS activation and tombstones
-> idempotently remove retired rows
```

Change the internal `ContentLoader`/`IIndexPipeline`/reindex-tool/test-helper path to load a `Uint8Array` once. Build `LoadedSource` from that buffer, compute the structured file hash from it, and derive the legacy `FileToChunk.content` only from the fatal-decoded text. Do not hash a re-encoded string or re-read the file for structured parsing.

Parser failure, strict UTF-8 failure, and an unavailable parser occur before SQLite stages a new pending generation. Leave the prior active structured generation and active vectors unchanged, do not clear an existing pending pointer owned by another attempt, and route the event through existing DLQ/incomplete behavior. On a partial Lance stage failure, delete only rows for the failed pending generation, then call `clearPendingGeneration` with that attempt's expected active generation, pending generation, and epoch. If that CAS returns `{ cleared: false }`, leave both catalog pointers unchanged and defer to reconciliation so a stale writer cannot remove newer pending work. If vector visibility activation fails, retain the pending pointer, retain the prior active catalog/vector pair, and mark the file DLQ/incomplete for reconciliation; do not auto-activate or clear it. If the SQLite activation CAS fails after vector visibility changes, catalog filtering keeps that generation hidden until reconciliation. On delete, retire active IDs, remove file rows, and keep tombstones. Treat a move as delete plus add for identity purposes while retaining the existing content-hash embedding-cache reuse.

Use a project-wide write coordinator shared by watcher processing, incremental reindex, startup full rebuild, manual full rebuild, and generation garbage collection. Make it the sole write-serialization boundary, or acquire it before the existing `IndexPipeline` mutex on every path; never introduce opposing lock order. Pair every per-file stage, activation, and pending clear with an epoch-aware expected active/pending CAS. A mismatch must leave pointers unchanged and enter reconciliation, so a stale writer cannot clear a newer pending generation.

- [ ] **Step 4: Run lifecycle, pipeline, and rename regression tests**

Run: `npx vitest run tests/unit/structured/structured-index-coordinator.test.ts tests/unit/indexer/pipeline-completion.test.ts tests/unit/indexer/pipeline-windowed.test.ts tests/unit/indexer/rename-detection.test.ts tests/integration/pipeline.test.ts`

Expected: PASS; pending rows never reach search, a partial stage clears only its own pending pointer, and active rows survive every injected pre-activation failure.

- [ ] **Step 5: Commit incremental generation coordination**

```bash
git add src/indexer/project-write-coordinator.ts src/indexer/structured-index-coordinator.ts src/indexer/pipeline.ts src/types/index.ts src/server/factory.ts src/server/tools/reindex.ts tests/shared/test-helpers.ts tests/unit/structured/structured-index-coordinator.test.ts tests/unit/indexer/pipeline-completion.test.ts tests/unit/indexer/pipeline-windowed.test.ts tests/unit/indexer/rename-detection.test.ts
git commit -m "feat: structured generationの段階的更新を追加"
```

### Task 10: Implement Full-Rebuild Barrier, Legacy Gate, and Restart Reconciliation

**Stack layer:** `feat/structured-indexing`

**Files:**

- Modify: `src/indexer/structured-index-coordinator.ts`
- Modify: `src/indexer/project-write-coordinator.ts`
- Modify: `src/indexer/pipeline.ts:543-626`
- Modify: `src/server/index.ts:116-228`
- Modify: `src/server/factory.ts:149-286,481-554`
- Create: `tests/unit/structured/full-rebuild-lifecycle.test.ts`
- Modify: `tests/unit/server/runtime-auto-index.test.ts`
- Modify: `tests/unit/indexer/event-queue-post-scan.test.ts`

**Interfaces:**

- Consumes: per-file coordinator from Task 9 and catalog control state from Task 4.
- Produces: persisted `building`, `idle`, and `failed` rebuild states; global readiness gate; queued watcher replay after full rebuild; idempotent restart reconciliation.

- [ ] **Step 1: Write failing tests for legacy, full rebuild, and restart states**

```ts
it("keeps a completed legacy index searchable through old tools but gates new tools", async () => {
  await seedLegacyIndex();
  expect(await structuredStatus()).toMatchObject({
    status: "reindex_required",
    reindexRequired: true,
  });
  expect(
    await service.getFileOutline({ filePath: "src/auth.ts" }),
  ).toMatchObject({
    status: "not_indexed",
    reasonCode: "STRUCTURED_INDEX_MISSING",
  });
});

it("does not activate a swapped shadow table when final SQLite activation fails", async () => {
  await coordinator.failFinalActivationOnce();
  await expect(runFullRebuild()).rejects.toThrow();
  expect(await catalog.getStructuredIndexState()).toMatchObject({
    rebuildState: "failed",
  });
  expect(await service.getSymbolSource({ symbolId })).toMatchObject({
    status: "not_indexed",
  });
});
```

Add barrier-controlled interleavings for watcher incremental write -> full rebuild and full rebuild -> queued watcher write. In both orders, verify that the coordinator acquires the same project write boundary before any legacy pipeline mutex, an older writer cannot clear a newer pending generation, and every run converges to one active catalog/vector pair or an explicit full-rebuild-required state.

- [ ] **Step 2: Run the full-rebuild tests to verify the gate is absent**

Run: `npx vitest run tests/unit/structured/full-rebuild-lifecycle.test.ts tests/unit/server/runtime-auto-index.test.ts`

Expected: FAIL because no structured rebuild state or shadow-table path exists.

- [ ] **Step 3: Implement the serialized full-rebuild protocol**

Implement the following under `runFullRebuild`, using the same coordinator and lock ordering as Task 9. Hold the project write lock from rebuild epoch increment through the final SQLite transaction, and do not leave an independent `IndexPipeline` mutex path that can race or deadlock with the coordinator:

```text
set control state building -> stage catalog generations pending
-> build a structured Lance shadow table -> validate all files, chunks, and DLQ
-> swap the Lance table while the global gate remains building
-> activate all catalog generations and schema version 1 in one SQLite transaction
-> mark control state idle -> release lock -> replay queued watcher events at current epoch
```

If anything fails before swap, retain the legacy/old table. If it fails after swap but before final SQLite activation, persist `failed`, do not expose a structured active pair, and require the next explicit full rebuild. On startup, convert a persisted `building` state to `failed`; never auto-activate pending data. Legacy schema remains `reindex_required`; future schema returns `unsupported` with `STRUCTURED_SCHEMA_UNSUPPORTED` and performs no data mutation.

- [ ] **Step 4: Run serialization and event-queue regression tests**

Run: `npx vitest run tests/unit/structured/full-rebuild-lifecycle.test.ts tests/unit/server/runtime-auto-index.test.ts tests/unit/indexer/event-queue-post-scan.test.ts tests/unit/indexer/pipeline.test.ts`

Expected: PASS; queued watcher events are replayed only after the barrier is released and stale writers cannot overwrite newer generations.

- [ ] **Step 5: Commit full rebuild and recovery behavior**

```bash
git add src/indexer/structured-index-coordinator.ts src/indexer/project-write-coordinator.ts src/indexer/pipeline.ts src/server/index.ts src/server/factory.ts tests/unit/structured/full-rebuild-lifecycle.test.ts tests/unit/server/runtime-auto-index.test.ts tests/unit/indexer/event-queue-post-scan.test.ts
git commit -m "feat: structured full rebuildの整合性を保証"
```

### Task 11: Build Freshness-Honest Outline and Exact-Source Retrieval

**Stack layer:** `feat/structured-retrieval`

**Files:**

- Create: `src/structured/retrieval-service.ts`
- Modify: `src/server/path-sanitizer.ts`
- Create: `tests/unit/structured/retrieval-service.test.ts`
- Modify: `tests/shared/create-test-nexus-options.ts`
- Modify: `tests/unit/server/path-sanitizer.test.ts`

**Interfaces:**

- Consumes: active/pending/tombstone catalog resolution, `PathSanitizer`, `sha256Hex`, and structured response contracts.
- Produces: `SymbolRetrievalService.getFileOutline(input)`, `getSymbolSource(input)`, and a shared single-buffer `VerifiedSymbol` result used by context retrieval.

- [ ] **Step 1: Write failing precedence and fail-closed tests**

```ts
it("does not read or return source when an ID is pending", async () => {
  const result = await service.getSymbolSource({ symbolId: pendingSymbolId });
  expect(result).toEqual({
    status: "index_incomplete",
    freshness: "unknown",
    reindexRequired: true,
    reasonCode: "INDEX_PENDING_GENERATION",
    request: { symbolId: pendingSymbolId },
  });
});

it("reads one buffer, rejects a changed file, and omits source", async () => {
  fileSystem.write("src/auth.ts", "changed");
  const result = await service.getSymbolSource({ symbolId: activeSymbolId });
  expect(result).toMatchObject({
    status: "stale",
    reasonCode: "INDEX_FILE_HASH_MISMATCH",
  });
  expect(result).not.toHaveProperty("source");
});

it("returns the old active source after failed stage cleanup when its bytes are current", async () => {
  await indexer.index(firstFileVersion);
  vectorStore.failOnBatch(2);
  await expect(indexer.index(secondFileVersion)).rejects.toThrow(
    "batch 2 failed",
  );

  fileSystem.write("src/auth.ts", firstFileVersion.content);
  await expect(
    service.getSymbolSource({ symbolId: firstSymbol.symbolId }),
  ).resolves.toMatchObject({
    status: "ok",
    freshness: "fresh",
    source: firstSymbol.rawSource,
  });
});
```

Cover all status precedence: future schema, full rebuild, legacy schema, excluded file, missing catalog file, pending file, missing current file, stale file hash, symbol hash mismatch, tombstone, unknown ID, unsupported language, partial outline, and an exact symbol in a partial file. Verify that a failed pending-stage cleanup removes only the failed attempt's pointer and that the prior active source is retrievable only after current bytes again match its active file hash; replacement bytes must remain source-free and fail closed. Explicitly assert that a nonexistent requested path with no active catalog record returns `not_found`/`FILE_NOT_FOUND`, while an `ENOENT` for a file with active catalog metadata returns `stale`/`INDEX_FILE_MISSING` rather than a transport error.

- [ ] **Step 2: Run the service test to verify the implementation is absent**

Run: `npx vitest run tests/unit/structured/retrieval-service.test.ts`

Expected: FAIL with a module-resolution error for `src/structured/retrieval-service.js`.

- [ ] **Step 3: Implement one strict resolution and verification path**

```ts
export class SymbolRetrievalService {
  async getFileOutline(input: {
    filePath: string;
    signal?: AbortSignal;
  }): Promise<FileOutlineResult>;
  async getSymbolSource(input: {
    symbolId: string;
    signal?: AbortSignal;
  }): Promise<SymbolSourceResult>;
  async getSymbolContext(input: {
    symbolId: string;
    tokenBudget: number;
    signal?: AbortSignal;
  }): Promise<SymbolContextResult>;
}
```

For source/context resolve in this exact order: pending ID, active/missing-generation check, active symbol, tombstone, scope/symlink validation, active-file pending pointer, one `readFile` to a `Uint8Array`, complete-file SHA-256, byte-range bounds, slice SHA-256, then `decodeUtf8` from `src/structured/hash.ts` on the verified slice. Use the same buffer for verification and slicing to avoid TOCTOU. Return `stale` for `ENOENT` while active catalog metadata exists and `stale_identity` only after the watcher has retired the identity. Do not use name, line, signature, or similarity fallback.

Split path handling into lexical project-relative validation and existing-path symlink resolution. After lexical validation, map `ENOENT` into the specified domain outcome while preserving `NEXUS_ACCESS_DENIED` for traversal, an existing escaping symlink, or permission denial. For outlines, apply global schema/rebuild gates, verify current file bytes before returning position metadata, sort exact symbols as preorder DFS and siblings by `startByte`, `kind`, `qualifiedName`, and `symbolId`. Return source-free exact subsets only for a fresh `degraded/partial` file.

- [ ] **Step 4: Run focused service tests and path-security tests**

Run: `npx vitest run tests/unit/structured/retrieval-service.test.ts tests/unit/server/path-sanitizer.test.ts`

Expected: PASS; all non-success source/context objects omit content and all path escapes remain `NEXUS_ACCESS_DENIED` transport errors.

- [ ] **Step 5: Commit outline and exact source retrieval**

```bash
git add src/structured/retrieval-service.ts src/server/path-sanitizer.ts tests/unit/structured/retrieval-service.test.ts tests/shared/create-test-nexus-options.ts tests/unit/server/path-sanitizer.test.ts
git commit -m "feat: 検証済みsymbol source取得を追加"
```

### Task 12: Implement Bounded Context Import Validation and Token Packing

**Stack layer:** `feat/structured-retrieval`

**Files:**

- Modify: `src/structured/retrieval-service.ts`
- Modify: `src/structured/tokenizer.ts`
- Modify: `tests/unit/structured/retrieval-service.test.ts`
- Modify: `tests/unit/structured/tokenizer.test.ts`

**Interfaces:**

- Consumes: the verified symbol buffer from Task 11 and the token packer from Task 2. Catalog-selected import records contain byte ranges, hashes, bindings, and metadata only; `rawSource` exists only on an in-memory candidate created after validation.
- Produces: an `ok` context response with one `context` string, byte ranges in that context, verified imports, import completeness, and the fixed budget object.

- [ ] **Step 1: Add failing tests for import hash verification and budget details**

```ts
it("fails closed before packing when one candidate import no longer matches its indexed hash", async () => {
  catalog.setImportHash(activeSymbolId, "different hash");
  const result = await service.getSymbolContext({
    symbolId: activeSymbolId,
    tokenBudget: 100,
  });

  expect(result).toMatchObject({
    status: "index_incomplete",
    reasonCode: "INDEX_IMPORT_HASH_MISMATCH",
  });
  expect(result).not.toHaveProperty("context");
});

it("derives an import rawSource from its verified UTF-8 byte slice", async () => {
  const result = await service.getSymbolContext({
    symbolId: activeSymbolId,
    tokenBudget: 100,
  });

  expect(result).toMatchObject({ status: "ok" });
  expect(result.context).toContain('import { café } from "./dep.js";');
});

it("keeps source order and later small imports after a too-large earlier import", async () => {
  const result = await service.getSymbolContext({
    symbolId: activeSymbolId,
    tokenBudget: 20,
  });
  expect(result.imports.map((item) => item.moduleSpecifier)).toEqual([
    "./small.js",
  ]);
  expect(result.budget.omittedForBudget).toBe(1);
});
```

Back the second test with a Unicode fixture whose persisted import record has only `startByte`, `endByte`, and `sourceHash`; it must not expose `rawSource` on its catalog type or SQLite row.

- [ ] **Step 2: Run the tests to verify context only has a source-level implementation**

Run: `npx vitest run tests/unit/structured/retrieval-service.test.ts tests/unit/structured/tokenizer.test.ts`

Expected: FAIL because import range verification and metadata offsets are absent.

- [ ] **Step 3: Validate every candidate before budget decisions**

Use the already-read verified file buffer to bounds-check and SHA-256-check every catalog-selected import. If any candidate fails, return `INDEX_IMPORT_HASH_MISMATCH` before counting tokens. For each valid import, create its in-memory `rawSource` only with `decodeUtf8(buffer.subarray(startByte, endByte))` after the matching slice hash is verified. Do not put `rawSource` in SQLite, catalog row types, or catalog-resolution results; parser artifacts may retain source only during indexing. Build the response exactly once from canonical source-order text:

```ts
const importText = includedImports.map((item) => item.rawSource).join("\n");
const context =
  importText.length > 0 ? `${importText}\n\n${symbolSource}` : symbolSource;
```

Compute `contextStartByte` and `contextEndByte` with `Buffer.byteLength` against this one response string. Include `importsCompleteness` from the catalog, set `exceeded` only when symbol-only context exceeds the requested budget, and set `omittedForBudget` only for certain related candidates excluded by budget. Do not repeat source text in a second response field.

- [ ] **Step 4: Run context and token behavior tests**

Run: `npx vitest run tests/unit/structured/retrieval-service.test.ts tests/unit/structured/tokenizer.test.ts`

Expected: PASS; complete symbol text is preserved under all budgets, each included import originates from its validated byte slice, and canonical token totals are reproducible.

- [ ] **Step 5: Commit bounded context retrieval**

```bash
git add src/structured/retrieval-service.ts src/structured/tokenizer.ts tests/unit/structured/retrieval-service.test.ts tests/unit/structured/tokenizer.test.ts
git commit -m "feat: symbol contextのbudget制御を追加"
```

### Task 13: Expose the Three MCP Tools with Schema and Error Parity

**Stack layer:** `feat/structured-retrieval`

**Files:**

- Create: `src/server/tools/get-file-outline.ts`
- Create: `src/server/tools/get-symbol-source.ts`
- Create: `src/server/tools/get-symbol-context.ts`
- Modify: `src/server/tools/types.ts:17-33`
- Modify: `src/server/tools/tool-support.ts:1-212`
- Modify: `src/server/tools/registry/schemas-neutral.ts:1-16`
- Modify: `src/server/tools/registry/definitions.ts:3-107`
- Modify: `src/server/tools/registry/adapters/v1-adapter.ts:8-40`
- Modify: `src/server/tools/registry/adapters/v2-adapter.ts:16-117`
- Modify: `src/server/errors.ts:1-48`
- Modify: `src/server/tools/index-status.ts:4-31`
- Modify: `src/server/factory.ts:481-554`
- Create: `tests/unit/server/tools/structured-retrieval.test.ts`
- Modify: `tests/unit/server/tools/registry/adapters/v1-adapter.test.ts`
- Modify: `tests/unit/server/tools/registry/adapters/v2-adapter.test.ts`
- Modify: `tests/unit/server/tools/index-status.test.ts`

**Interfaces:**

- Consumes: `SymbolRetrievalService` from Tasks 11-12.
- Produces: MCP tools `get_file_outline({ filePath })`, `get_symbol_source({ symbolId })`, and `get_symbol_context({ symbolId, tokenBudget })` through v1 and v2 registries.

- [ ] **Step 1: Write failing handler and adapter parity tests**

```ts
it.each([
  [{ symbolId: validSymbolId }, true],
  [{ symbolId: "symbol_v1_short" }, false],
])("validates symbolId equally in both adapters", (args, valid) => {
  expect(() => v1Schema.safeParse(args).success).toBe(valid);
  expect(() => v2Schema.safeParse(args).success).toBe(valid);
});

it.each([1, 100_000])("accepts tokenBudget boundary %i", (tokenBudget) => {
  expect(
    v2ContextSchema.safeParse({ symbolId: validSymbolId, tokenBudget }).success,
  ).toBe(true);
});

it.each([0, 100_001, 1.5])(
  "rejects invalid tokenBudget %p before calling the handler",
  (tokenBudget) => {
    expect(
      v2ContextSchema.safeParse({ symbolId: validSymbolId, tokenBudget })
        .success,
    ).toBe(false);
  },
);
```

Also assert all non-`ok` source/context tool payloads omit `source` and `context`, v1/v2 list all nine tools, existing six schemas are byte-for-byte unchanged, and `index_status.structuredIndex` is optional.

- [ ] **Step 2: Run tool and adapter tests to verify the registrations are absent**

Run: `npx vitest run tests/unit/server/tools/structured-retrieval.test.ts tests/unit/server/tools/registry/adapters/v1-adapter.test.ts tests/unit/server/tools/registry/adapters/v2-adapter.test.ts`

Expected: FAIL because the new definitions, neutral constraints, and handler dependencies do not exist.

- [ ] **Step 3: Add neutral constraints and thin tool handlers**

```ts
export type NeutralField =
  | {
      kind: "string";
      pattern?: string;
      optional?: boolean;
      description?: string;
    }
  | {
      kind: "integer";
      minimum?: number;
      maximum?: number;
      optional?: boolean;
      description?: string;
    }
  | { kind: "number"; optional?: boolean; description?: string }
  | {
      kind: "boolean";
      optional?: boolean;
      default?: boolean;
      description?: string;
    }
  | { kind: "stringArray"; optional?: boolean; description?: string }
  | {
      kind: "enum";
      values: [string, ...string[]];
      optional?: boolean;
      default?: string;
      description?: string;
    };
```

Register `symbolId` with pattern `^symbol_v1_[A-Za-z0-9_-]{43}$` and `tokenBudget` with `minimum: 1` and `maximum: 100000`. Map patterns and inclusive bounds to Zod v3, JSON Schema, and Zod v4. Preserve the special v2 operational limit only for `topK` and `maxResults`; declared maxima for structured fields must not be changed.

Convert invalid schema input to `NEXUS_INVALID_ARGUMENT`, cancellation to `NEXUS_REQUEST_CANCELLED`, traversal/symlink errors to `NEXUS_ACCESS_DENIED`, and storage errors to `NEXUS_STORAGE_UNAVAILABLE`. Domain outcomes remain successful MCP transport calls with structured result statuses. Build `SymbolRetrievalService` once in `NexusServerFactory.createRuntime`, pass it through `NexusServerOptions`, and wrap each handler with the existing `withToolMetrics` and `toolResult` functions.

Extend `index_status` with optional `structuredIndex` fields `schemaVersion`, `targetSchemaVersion`, `status`, `rebuildState`, `lastErrorCode`, `totalFiles`, `totalSymbols`, `exactFiles`, `degradedFiles`, `pendingFiles`, and `reindexRequired` without changing existing fields.

- [ ] **Step 4: Run unit tool, adapter, and protocol tests**

Run: `npx vitest run tests/unit/server/tools/structured-retrieval.test.ts tests/unit/server/tools/registry/adapters/v1-adapter.test.ts tests/unit/server/tools/registry/adapters/v2-adapter.test.ts tests/unit/server/tools/index-status.test.ts tests/integration/mcp-protocol.test.ts`

Expected: PASS; both MCP versions reject invalid input before handler invocation and expose all three tools.

- [ ] **Step 5: Commit the MCP surface**

```bash
git add src/server/tools/get-file-outline.ts src/server/tools/get-symbol-source.ts src/server/tools/get-symbol-context.ts src/server/tools/types.ts src/server/tools/tool-support.ts src/server/tools/registry/schemas-neutral.ts src/server/tools/registry/definitions.ts src/server/tools/registry/adapters/v1-adapter.ts src/server/tools/registry/adapters/v2-adapter.ts src/server/errors.ts src/server/tools/index-status.ts src/server/factory.ts tests/unit/server/tools/structured-retrieval.test.ts tests/unit/server/tools/registry/adapters/v1-adapter.test.ts tests/unit/server/tools/registry/adapters/v2-adapter.test.ts tests/unit/server/tools/index-status.test.ts tests/integration/mcp-protocol.test.ts
git commit -m "feat: structured retrieval MCP toolを公開"
```

### Task 14: Add End-to-End Acceptance, Metrics, Benchmarks, and Agent Guidance

**Stack layer:** `docs/structured-retrieval`

**Files:**

- Create: `tests/integration/structured-retrieval.test.ts`
- Create: `tests/unit/docs/structured-retrieval-guidance.test.ts`
- Create: `tests/benchmarks/structured-retrieval.bench.ts`
- Modify: `src/observability/types.ts`
- Modify: `src/observability/metrics-collector.ts`
- Modify: `tests/unit/observability/metrics-collector.test.ts`
- Modify: `README.md`
- Modify: `SPEC.md`
- Modify: `docs/mcp-tools.md`
- Modify: `.agents/skills/code-search.md`

**Interfaces:**

- Consumes: the complete runtime from Tasks 1-13.
- Produces: AC-1 through AC-17 traceable integration coverage, low-cardinality structured metrics, benchmark reports, and updated agent-facing retrieval guidance.

- [ ] **Step 1: Write failing integration acceptance tests before documentation edits**

```ts
it("moves from semantic search to complete source through one symbol ID", async () => {
  const search = await callTool("semantic_search", {
    query: "authenticate",
    topK: 10,
  });
  const symbolId = search.results.find((item) => item.chunk.symbolId)?.chunk
    .symbolId;
  expect(symbolId).toMatch(/^symbol_v1_[A-Za-z0-9_-]{43}$/);

  const source = await callTool("get_symbol_source", { symbolId });
  expect(source).toMatchObject({ status: "ok", freshness: "fresh" });
  expect(source.source).toContain("export async function authenticate");
});

it("keeps structured retrieval usable when embeddings are unavailable", async () => {
  runtime.embeddingProvider.failHealthCheck();

  const outline = await callTool("get_file_outline", {
    filePath: "src/auth.ts",
  });
  expect(outline).toMatchObject({ status: "ok" });

  const source = await callTool("get_symbol_source", {
    symbolId: outline.symbols[0].symbolId,
  });
  expect(source).toMatchObject({ status: "ok" });

  const context = await callTool("get_symbol_context", {
    symbolId: outline.symbols[0].symbolId,
    tokenBudget: 2000,
  });
  expect(context).toMatchObject({ status: "ok" });
});
```

Add the following acceptance traceability matrix. Each named test must be implemented as written, and its assertion must cover the stated expected result.

| AC ID | Requirement                                       | Test file                                               | Test name                                                                            | Expected result                                                                                                                                              |
| ----- | ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-1  | Search to exact retrieval                         | `tests/integration/structured-retrieval.test.ts`        | `moves from semantic search to complete source through one symbol ID`                | A structured search result has `symbolId`; `get_symbol_source` returns the complete source with `ok`/`fresh` without a name lookup.                          |
| AC-2  | Split search chunks are hidden by exact retrieval | `tests/integration/structured-retrieval.test.ts`        | `reuses one symbol ID across split chunks and retrieves one complete declaration`    | Every split chunk has one ID and that ID resolves to the whole declaration.                                                                                  |
| AC-3  | Outline to exact retrieval                        | `tests/integration/structured-retrieval.test.ts`        | `navigates from a file outline to source and context`                                | A source-free outline ID resolves through both structured retrieval tools.                                                                                   |
| AC-4  | Outline metadata and no source                    | `tests/integration/structured-retrieval.test.ts`        | `returns source-free outline metadata with hierarchy`                                | Each exact outline item includes identity, qualified name, kind, signature, position, and parent relationship, but no source text.                           |
| AC-5  | Reindex identity stability                        | `tests/integration/structured-retrieval.test.ts`        | `preserves a logical ID across body and position-only reindexing`                    | The ID is unchanged after body and line-position changes.                                                                                                    |
| AC-6  | Same-name disambiguation                          | `tests/integration/structured-retrieval.test.ts`        | `retrieves same-named overloads by their distinct IDs`                               | Each ID returns only its corresponding declaration.                                                                                                          |
| AC-7  | Retired identity safety                           | `tests/integration/structured-retrieval.test.ts`        | `reports a retired ID without a similarity fallback`                                 | The response is source-free `stale_identity` with `SYMBOL_RETIRED`.                                                                                          |
| AC-8  | Complete declaration source                       | `tests/integration/structured-retrieval.test.ts`        | `includes attached decorators and documentation in exact source`                     | Exact source includes attached declaration elements and excludes unrelated comments.                                                                         |
| AC-9  | Bounded import context                            | `tests/integration/structured-retrieval.test.ts`        | `packs verified related imports before a complete symbol`                            | Context contains only verified related imports and the complete symbol.                                                                                      |
| AC-10 | Token budget overflow                             | `tests/integration/structured-retrieval.test.ts`        | `keeps an overflowing symbol complete and reports its budget state`                  | The complete symbol is returned with accurate requested, actual, and overflow fields.                                                                        |
| AC-11 | Fresh result                                      | `tests/integration/structured-retrieval.test.ts`        | `marks matching working-tree bytes as fresh`                                         | A matching file returns `ok` with `freshness: "fresh"`.                                                                                                      |
| AC-12 | Stale result                                      | `tests/integration/structured-retrieval.test.ts`        | `fails closed for changed working-tree bytes`                                        | Changed bytes return source-free `stale` with `INDEX_FILE_HASH_MISMATCH`.                                                                                    |
| AC-13 | Parser failure                                    | `tests/integration/structured-retrieval.test.ts`        | `reports parser failure without exposing fixed-line chunks as symbols`               | The result is machine-readable unavailable or degraded and exposes no fallback `symbolId`.                                                                   |
| AC-14 | Embedding independence                            | `tests/integration/structured-retrieval.test.ts`        | `keeps structured retrieval usable when embeddings are unavailable`                  | `get_file_outline`, `get_symbol_source`, and `get_symbol_context` all return successful (`ok`) structured results while embedding health fails. |
| AC-15 | Existing-tool compatibility                       | `tests/integration/mcp-protocol.test.ts`                | `keeps existing six tool contracts and registers structured tools in both v1 and v2` | Existing v1 and v2 schemas/response fields for the six legacy tools remain unchanged; `get_file_outline`, `get_symbol_source`, and `get_symbol_context` register in both `createNexusServer` (v1) and `createV2McpHandler` (v2) tool lists and can be invoked successfully. |
| AC-16 | Retrieval scope consistency                       | `tests/integration/structured-retrieval.test.ts`        | `returns excluded status for an index-excluded file`                                 | An excluded file returns source-free `excluded` with `PATH_EXCLUDED`.                                                                                        |
| AC-17 | Agent guidance                                    | `tests/unit/docs/structured-retrieval-guidance.test.ts` | `documents the canonical symbol-aware retrieval flow`                                | README, SPEC, MCP documentation, and code-search guidance all direct symbol-aware results to source/context retrieval and preserve `get_context` exceptions. |

Add these real-server surface scenarios to the same acceptance plan:

| Related AC   | Test file                                        | Test name                                                               | Expected result                                                                                        |
| ------------ | ------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| AC-12        | `tests/integration/structured-retrieval.test.ts` | `returns stale before watcher staging begins`                           | A changed active file is source-free `stale` before its pending pointer is staged.                     |
| AC-11, AC-12 | `tests/integration/structured-retrieval.test.ts` | `gates only the pending file while unrelated active files remain fresh` | The pending file is source-free `index_incomplete`; an unrelated active file remains `ok`/`fresh`.     |
| AC-11, AC-12 | `tests/integration/structured-retrieval.test.ts` | `recovers fresh retrieval after a successful reindex`                   | A stale or pending file becomes `ok`/`fresh` only after reindex completes.                             |
| AC-13, AC-16 | `tests/integration/structured-retrieval.test.ts` | `returns machine-readable unsupported and excluded outcomes`            | Unsupported and excluded files return their respective source-free statuses without a fallback symbol. |
| AC-9, AC-10  | `tests/integration/structured-retrieval.test.ts` | `accepts tokenBudget 100000 at the real-server surface`                 | The real server accepts the inclusive boundary and returns the normal bounded-context result.          |

Retain `accepts tokenBudget 100000 and rejects 100001 before handler invocation` in `tests/integration/mcp-protocol.test.ts` as the v1/v2 schema-parity regression for the same AC-9/AC-10 boundary.

`tests/unit/docs/structured-retrieval-guidance.test.ts` must read the four public guidance files and assert the two canonical flows plus the retained `get_context` exceptions, so AC-17 is mechanically checked rather than inferred from an integration scenario.

- [ ] **Step 2: Run acceptance tests to verify the end-to-end flow has gaps**

Run: `npx vitest run tests/integration/structured-retrieval.test.ts tests/integration/mcp-protocol.test.ts tests/unit/docs/structured-retrieval-guidance.test.ts`

Expected: FAIL until all prior layers are connected through an actual runtime and MCP client.

- [ ] **Step 3: Add low-cardinality structured metrics and a reproducible benchmark**

Add these metrics with only `tool`, `status`, `language`, `parse_status`, `coverage`, or fixed result labels:

```text
nexus_structured_retrieval_outcomes_total
nexus_structured_parser_outcomes_total
nexus_structured_context_tokens
nexus_structured_budget_overflows_total
nexus_structured_catalog_files
nexus_structured_catalog_symbols
nexus_structured_catalog_coverage_files
```

Record no source-derived label. Add benchmark datasets for this repository, a mixed TypeScript/Python/Go fixture, and a synthetic fixture with many symbols, large classes, overloads, and Unicode. Report environment, warm-up count, measurement count, median, p95, absolute values, percentage deltas, and each regression disposition as accepted, mitigated, or blocked. Treat clear existing-search or indexing regressions as release blockers rather than enforcing an arbitrary fixed KPI.

- [ ] **Step 4: Document the public contract and standard agent flow**

Update all documentation with these exact flows:

```text
semantic_search / hybrid_search result with symbolId
  -> get_symbol_source or get_symbol_context

known supported file
  -> get_file_outline
  -> get_symbol_source or get_symbol_context
```

State that arbitrary grep hits, line-oriented requests, excluded/unsupported files, and parser-uncertain declarations continue to use `get_context`. Document the explicit full-rebuild upgrade requirement and the complete status/reason-code matrix. Preserve existing CodeGraph guidance unchanged.

- [ ] **Step 5: Run the full verification suite and benchmark**

Run: `npm run lint && npx tsc --noEmit && npx vitest run && npm run build && npx vitest bench tests/benchmarks/structured-retrieval.bench.ts`

Expected: PASS; the benchmark emits a reviewable report and no test exposes stale source as a success.

- [ ] **Step 6: Commit verification, observability, and documentation**

```bash
git add tests/integration/structured-retrieval.test.ts tests/integration/mcp-protocol.test.ts tests/unit/docs/structured-retrieval-guidance.test.ts tests/benchmarks/structured-retrieval.bench.ts src/observability/types.ts src/observability/metrics-collector.ts tests/unit/observability/metrics-collector.test.ts README.md SPEC.md docs/mcp-tools.md .agents/skills/code-search.md
git commit -m "docs: structured retrievalの利用方法を追加"
```

## Plan Review

### Spec Coverage

| Requirement area                                                               | Tasks                         |
| ------------------------------------------------------------------------------ | ----------------------------- |
| Stable logical symbol identity, canonical generation, exact byte hashes        | 1, 5, 6, 7                    |
| Fixed token accounting and complete-symbol precedence                          | 2, 12                         |
| SQLite catalog, tombstones, and legacy control state                           | 3, 4, 10                      |
| TypeScript, Python, and Go parser contracts                                    | 5, 6, 7                       |
| Search chunk `symbolId` linkage and LanceDB separation                         | 8, 9                          |
| Pending/active consistency, failures, locks, and reconciliation                | 9, 10                         |
| Fresh outline/source/context retrieval statuses                                | 11, 12                        |
| MCP schemas, validation, errors, existing-tool compatibility, and index status | 13                            |
| AC-1 through AC-17, surface QA, metrics, benchmark, and documentation          | 14                            |
| Focused stacked PR creation and reviewable branch boundaries                   | Stacked Pull Requests section |

All available structured retrieval requirements are mapped to implementation tasks. The unavailable agent-skills distribution design is explicitly excluded rather than guessed.

### Local Feasibility Corrections

- Structured indexing carries original bytes through one `LoadedSource`/`StructuredSource` flow; hashes never depend on a re-encoded string.
- Vector storage owns row visibility only. `SemanticSearch` batch-checks structured `(filePath, generationId)` candidates against SQLite's active-generation map, avoiding a storage-layer dependency cycle and hiding transition rows.
- Path validation separates lexical project scope from existing-file symlink resolution so `ENOENT` produces the specified domain status while traversal and escaping symlinks remain transport errors.
- The shared coordinator defines lock ordering across watcher, incremental reindex, full rebuild, and queued-event replay; barrier tests cover both interleavings.
- The PR stack uses the configured trunk and remote rather than assuming `master` or `origin`.

### Placeholder Scan

The plan contains no `TODO`, `TBD`, `implement later`, or generic test instruction. Every task names files, interfaces, executable tests, expected outcomes, implementation behavior, and a scoped commit.

### Type Consistency

Tasks 1 and 9 carry exact bytes through `StructuredSource`/`LoadedSource`; parser tasks consume that source and produce `StructuredParseResult`; catalog tasks consume it as `StructuredGenerationStage`; indexing tasks activate it through `IStructuredCatalog` and `IVectorStore`; `SemanticSearch` filters structured rows through the catalog generation map; retrieval tasks expose it through `SymbolRetrievalService`; MCP handlers inject that service through `NexusServerOptions`. `CodeChunk.symbolId` is optional throughout, preserving fallback and legacy rows.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-28-structured-symbol-retrieval.md`.

Use Inline Execution only: execute the tasks in this session with `superpowers:executing-plans`, use the six-layer `gh stack` sequence above for focused PRs, and do not dispatch subagents.
