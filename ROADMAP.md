# Nexus Roadmap

This document is the canonical source for Nexus **future target state and planned work**. It is not the source of truth for current runtime behavior.

For current architecture invariants and compatibility contracts, see [SPEC.md](SPEC.md). For released work, see [CHANGELOG.md](CHANGELOG.md).

## Status

- **Implemented** — available in the current implementation; current behavior is documented elsewhere.
- **Partial** — some target behavior exists, but the roadmap target is not complete.
- **Planned** — future target; do not treat it as current product behavior.

## Implemented foundation

The following roadmap foundations are already present in the current product and are therefore described normatively in [SPEC.md](SPEC.md):

- MCP v2 tool contracts and local Streamable HTTP transport
- loopback-only local HTTP server constraints
- local HTTP bridge / managed project server
- project-local indexing and search
- semantic, grep, and hybrid search
- structured symbol retrieval with stable symbol identity
- package mode and current Bedrock packaging constraints
- metrics, dashboard, and aggregator support

## Planned: remote/cloud HTTP access

Target: allow authorized AI clients to use a remote Nexus service without exposing the local-only server model directly.

The planned remote service must define explicit authentication/authorization, request isolation, rate/abuse controls, storage ownership, and an externally supported transport contract. Local HTTP v2 remains loopback-only unless and until a separate remote architecture is implemented.

## Planned: Sync Agent

Target: introduce a `nexus sync`-style workflow that synchronizes project/index state to the remote service.

The sync design must preserve deterministic revision identity, avoid exposing arbitrary host paths, and define retry/resume behavior. The current repository does not treat this planned sync flow as part of the local runtime contract.

## Planned: cloud storage adapters

The prior requirements identified Cloudflare-oriented storage candidates:

- D1 for metadata
- Vectorize for vector search
- R2 for content/blob storage

These are roadmap candidates, not current local storage behavior. Any implementation must preserve the logical contracts currently provided by SQLite/LanceDB/content access while making workspace/revision isolation explicit.

## Planned: cloud MCP service

Target: a remotely hosted MCP-facing service backed by the cloud storage/sync model.

Before this can become current behavior, the project must define and implement:

1. authentication and authorization;
2. workspace/revision routing;
3. remote content retrieval boundaries;
4. storage lifecycle and garbage collection;
5. observability and operator controls;
6. compatibility/migration from the local-only model.

## Planned: migration and coexistence

A future remote architecture should coexist with the current local-first product during migration rather than silently changing local transport/security guarantees.

Migration documentation must be added only when an implemented migration path exists. Until then, [SPEC.md](SPEC.md) remains authoritative for current local behavior.

## Roadmap maintenance rules

- Move an item out of **Planned** only when implementation and tests exist.
- Update [SPEC.md](SPEC.md) first when an implemented roadmap item changes current normative behavior.
- Record released changes in [CHANGELOG.md](CHANGELOG.md).
- Do not duplicate complete MCP schemas, configuration catalogs, or runbooks in this roadmap.
