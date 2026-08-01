# Instructions for AI Agents (Nexus)

Nexus is a local-first TypeScript MCP server that gives AI agents fast,
private, evidence-based codebase search and context retrieval.

## Repository map

- `src/`: MCP server, search/indexing pipeline, storage, plugins, and
  observability runtime.
- `packages/dashboard/`: npm workspace for the TUI and telemetry aggregator.
- `tests/`: Vitest unit, integration, stress, and benchmark coverage.

## Working conventions

- Use Node.js >=24 and `npm`; `package-lock.json` is authoritative.
- Prefer existing patterns and deterministic tools over prose style rules.
- Keep local-first behavior intact: do not introduce external source-code transmission.
- Do not commit credentials, tokens, machine-specific paths, or generated
  local state.

## Mandatory constraints

<!-- #mandatory-constraints also kept for compatibility -->

- Before setup, ask the user to choose **Source Build** or **Package Usage**,
  then follow [docs/setup.md](docs/setup.md).
- Never ask the user to paste secrets or GitHub tokens into chat.
- Do not create project-level agent configuration files or directories;
  `.agents/skills/` is the repository's canonical skills location.

## Code investigation

- Load `.agents/skills/code-search.md` before code investigation or design exploration.
- If `.codegraph/` exists, use `codegraph_explore` for structural or call-tree tracing.
- Before Nexus searches, run `index_status`; use `hybrid_search` for conceptual
  discovery and `grep_search` for exact symbols or error strings.
- Use `get_context` with explicit `startLine` and `endLine` when the relevant
  range is known.

## Verification

- Run the narrowest relevant Vitest test first: `npx vitest run <test-file>`.
- For TypeScript changes, run `npm run lint`; run `npm run build` when public
  exports, package output, or workspace integration changes.
- Run `npx vitest run` before completion when the change affects multiple
  subsystems or shared behavior.

## Progressive disclosure

- Architecture and behavioral contracts: [SPEC.md](SPEC.md)
- Setup choices and prerequisites: [docs/setup.md](docs/setup.md)
- Runtime configuration: [docs/configuration.md](docs/configuration.md)
- MCP tool inputs and responses: [docs/mcp-tools.md](docs/mcp-tools.md)
- Distribution workflows: [docs/distribution.md](docs/distribution.md)
- Metrics and dashboards: [docs/observability/README.md](docs/observability/README.md)
