# Nexus — Instructions for AI Agents

Nexus is a local-first TypeScript MCP server for fast, evidence-based codebase search and exact symbol context retrieval.

## Repository Map

- **Root**: MCP server, retrieval engines, storage, indexing pipeline, transport, and CLI.
- **`packages/dashboard/`**: observability and metrics dashboard.
- **`.agents/skills/`**: canonical task-specific repository skills.

## Core Principles

- Prefer verified repository evidence over guesses.
- Keep code exploration local-first. External embedding providers can transmit source-derived text; do not enable or introduce external transmission unless the task requires it.
- Use deterministic tooling: tests, type checking, linting, and build output are authoritative over prose assumptions.
- Current technical behavior is defined by [SPEC.md](SPEC.md); future target state is defined separately by [ROADMAP.md](ROADMAP.md).

## Workflow

- **Environment**: Node.js >=24 and npm. `package-lock.json` is authoritative.
- **Code investigation**: load [.agents/skills/code-search.md](.agents/skills/code-search.md) before repository search or implementation tracing.
- **Focused tests**: `npx vitest run <file>`.
- **Full tests**: `npx vitest run`.
- **Type check**: `npx tsc --noEmit`.
- **Lint**: `npm run lint`.
- **Build**: `npm run build` when changing public exports, CLI output, package artifacts, or build-sensitive code.

## Universal Constraints

- Do not commit credentials, tokens, machine-specific paths, or generated local state.
- Never ask the user to paste secrets, GitHub tokens, or other credentials into chat.
- Before an initial Nexus installation/setup, ask the user to choose **Source Build** or **Package Usage** before running setup commands. Do not choose an installation mode on the user's behalf.
- Do not create project-level agent configuration files outside [.agents/skills/](.agents/skills/).
- Do not duplicate repository-wide agent rules into README or human setup documentation.

## Progressive Disclosure

Read a document only when its topic is relevant:

- Current architecture and behavioral contracts: [SPEC.md](SPEC.md)
- Future product direction: [ROADMAP.md](ROADMAP.md)
- MCP tool reference: [docs/mcp-tools.md](docs/mcp-tools.md)
- Runtime configuration: [docs/configuration.md](docs/configuration.md)
- Human setup and prerequisites: [docs/setup.md](docs/setup.md)
- Packaging and release distribution: [docs/distribution.md](docs/distribution.md)
- Metrics and Grafana dashboard: [docs/observability/README.md](docs/observability/README.md)
