# Instructions for AI Agents (Nexus)

Nexus is a local-first MCP server for codebase indexing, hybrid search, and precise context retrieval for AI agents.

## Project context

- **What**: TypeScript MCP server with local LanceDB vector store, ripgrep search, file-watching indexer, and observability dashboards.
- **How**: Node.js >=24; use `npm` (package-lock.json present). Run `npx vitest` for tests and `npm run lint` for TypeScript changes.
- **Why**: Give AI agents fast, private, evidence-based codebase exploration without external data transmission.

## Mandatory constraints

- Before setup, ask the user to choose **Source Build** or **Package Usage**; follow [docs/setup.md](docs/setup.md) after the choice.
- Never ask the user to paste secrets or GitHub tokens into chat.
- Preserve local-first behavior; do not commit machine-specific paths, credentials, tokens, or generated local state.
- Do not create project-level agent configuration files or directories; `.agents/skills/` is the canonical exception for this plan.

## Tool selection triggers

- Code investigation or design exploration → load `.agents/skills/code-search.md`.
- Structural or call-tree tracing (only if `.codegraph/` exists) → use `codegraph_explore`.
- Vague or conceptual search → use `nexus/hybrid_search`.
- Exact symbol or error-string search → use `nexus/grep_search`.
- Minimal file context retrieval → use `nexus/get_context` with `startLine` and `endLine`.

## Verification

- Run the narrowest relevant Vitest test first, then `npm run lint` for TypeScript changes.
- For architecture, setup, configuration, distribution, and observability details, see [SPEC.md](SPEC.md), [docs/setup.md](docs/setup.md), [docs/configuration.md](docs/configuration.md), [docs/distribution.md](docs/distribution.md), and [docs/observability/README.md](docs/observability/README.md).
