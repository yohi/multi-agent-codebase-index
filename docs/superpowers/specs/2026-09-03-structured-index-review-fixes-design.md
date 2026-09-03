# Structured Index Review Fixes Design

## Goal

Restore the structured-index lifecycle, epoch, chunk-range, lock-timeout, and
search-parity invariants identified during review without changing the empty
shadow-table behavior.

## Scope

The implementation covers five findings:

1. Preserve the LanceDB structured table handle after empty reconciliation.
2. Propagate the catalog rebuild epoch during per-file staging.
3. Keep oversized structured chunk ranges and IDs consistent.
4. Enforce the optional project lock timeout.
5. Match InMemoryVectorStore search deduplication with LanceDB.

The empty shadow-table swap finding is not changed because dropping the old
table and the empty shadow table leaves a valid empty state.

## Design

`reconcileStructuredRows([])` will delete rows but retain the existing table
handle. Subsequent staging can append to the empty table instead of attempting
to create a table with an already-used name.

`StructuredIndexCoordinator.stageFile()` will pass the epoch read from
`getStructuredIndexState()` to `stageGeneration()`. Per-file staging will not
advance the global epoch; epoch changes remain the responsibility of full
rebuild coordination.

Structured chunk splitting will use the line span represented by `rawSource`,
including any leading Go comments or directives. After final line boundaries
are determined, each subchunk ID will be generated from those same boundaries.

`ProjectWriteCoordinator` will wrap its mutex with `withTimeout` when
`lockTimeoutMs` is explicitly configured. The existing indefinite-wait behavior
will remain when no timeout is supplied.

In-memory search will combine candidates in the same order as LanceDB, apply
the same score/path ordering, remove duplicate `chunk.id` values, and then
apply `topK`.

## Verification

Regression tests will cover empty reconciliation followed by staging, epoch
propagation, oversized raw-source line ranges and IDs, lock timeout rejection,
and legacy/structured duplicate search results. Focused tests, lint, TypeScript
checking, build, and the full Vitest suite will run before commit.
