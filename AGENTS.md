# Nexus — Instructions for AI Agents

Nexus is a local-first TypeScript MCP server that gives AI agents fast, private, evidence-based codebase search and context retrieval.

## How to work on this project

- Use Node.js >=24 and `npm`; `package-lock.json` is authoritative.
- Prefer existing patterns and deterministic tools (linter, type checker, tests) over prose style rules.
- Keep local-first behavior intact: do not introduce external source-code transmission.
- Do not commit credentials, tokens, machine-specific paths, or generated local state.

## Mandatory constraints

- Before setup, ask the user to choose **Source Build** or **Package Usage**, then follow [docs/setup.md](docs/setup.md).
- Never ask the user to paste secrets or GitHub tokens into chat.
- Do not create project-level agent configuration files or directories; [`.agents/skills/`](.agents/skills/) is the repository's canonical skills location.

## How to investigate and verify

- Load [`.agents/skills/code-search.md`](.agents/skills/code-search.md) before any code investigation; it defines the standard pipeline, One-Call pattern, and tool selection rules.
- Run the narrowest relevant Vitest test first: `npx vitest run <test-file>`.
- Run `npm run lint` for TypeScript changes; run `npm run build` when public exports, package output, or workspace integration changes.
- Run `npx vitest run` before completion when a change affects multiple subsystems or shared behavior.

## Progressive disclosure

- Architecture and behavioral contracts: [SPEC.md](SPEC.md)
- Setup choices and prerequisites: [docs/setup.md](docs/setup.md)
- Runtime configuration: [docs/configuration.md](docs/configuration.md)
- MCP tool inputs and responses: [docs/mcp-tools.md](docs/mcp-tools.md)
- Distribution workflows: [docs/distribution.md](docs/distribution.md)
- Metrics and dashboards: [docs/observability/README.md](docs/observability/README.md)
