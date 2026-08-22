# Nexus — Instructions for AI Agents

Nexus is a local-first TypeScript MCP server that gives AI agents fast,
private, evidence-based codebase search and context retrieval.

## How to work on this project

- Use Node.js >=24 and `npm`; `package-lock.json` is authoritative.
- This repository is an npm workspace (`packages/*`); the only package is
  [`packages/dashboard`](packages/dashboard).
- Prefer existing patterns and deterministic tools (linter, type checker,
  tests) over prose-style rules.
- Keep local-first behavior intact: do not introduce external
  source-code transmission.
- Do not commit credentials, tokens, machine-specific paths, or
  generated local state.

## Mandatory constraints

- Before setup, ask the user to choose **Source Build** or **Package Usage**,
  then follow [docs/setup.md](docs/setup.md).
- Never ask the user to paste secrets or GitHub tokens into chat.
- Do not create project-level agent configuration files or directories;
  [`.agents/skills/`](.agents/skills/) is the repository's canonical skills
  location.

## How to investigate and verify

- Load [`.agents/skills/code-search.md`](.agents/skills/code-search.md)
  before any code investigation; it defines the standard pipeline,
  One-Call pattern, and tool selection rules.
- Run the narrowest relevant Vitest test first: `npx vitest run <test-file>`.
- Run `npm run lint` and `npx tsc --noEmit` for TypeScript changes.
- Run `npm run build` when public exports, package output, or workspace
  integration change.
- Run `npx vitest run` before completion when a change affects multiple
  subsystems or shared behavior.

## Progressive disclosure

Read a document only when its topic is relevant to the current task.

- Architecture and behavioral contracts (before design changes):
  [SPEC.md](SPEC.md)
- Setup choices and prerequisites (before installation tasks):
  [docs/setup.md](docs/setup.md)
- Runtime configuration keys and env vars:
  [docs/configuration.md](docs/configuration.md)
- MCP tool inputs and responses (before tool schema changes):
  [docs/mcp-tools.md](docs/mcp-tools.md)
- Distribution workflows (before packaging or release changes):
  [docs/distribution.md](docs/distribution.md)
- Metrics and dashboards:
  [docs/observability/README.md](docs/observability/README.md)
- Product requirements and phase roadmap (for scope questions):
  [REQUIREMENTS.md](REQUIREMENTS.md)
