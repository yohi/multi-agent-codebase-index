# Nexus — Instructions for AI Agents

Nexus is a local-first TypeScript MCP server that provides fast,
private, evidence-based codebase search and symbol context retrieval.

## What: Architecture & Map

- **Root**: Core MCP server, retrieval engines (AST/BM25/vector), storage, and CLI.
- **`packages/dashboard`**: Observability and metrics web dashboard (npm workspace).
- **`.agents/skills/`**: Canonical repository skills (e.g. [`code-search.md`](.agents/skills/code-search.md)).

## Why: Core Principles

- **Local-first & private**: Source code never leaves the host machine; no external egress.
- **Evidence-based**: Ground retrievals in verified symbols and deterministic tools over guessing.
- **Deterministic tooling**: Rely on the linter, type checker, and tests rather than prose rules.

## How: Workflow & Commands

- **Environment**: Node.js >=24 and `npm`; `package-lock.json` is authoritative.
- **Investigation**: Load [`.agents/skills/code-search.md`](.agents/skills/code-search.md) before code search.
- **Test**: `npx vitest run <file>` (narrow first), `npx vitest run` (before completion).
- **Typecheck**: `npx tsc --noEmit`
- **Lint**: `npm run lint`
- **Build**: `npm run build` (when changing public exports or package outputs).

## Universal Constraints

- Do not commit credentials, tokens, machine-specific paths, or generated local state.
- Never ask the user to paste secrets or GitHub tokens into chat.
- Ask the user to choose **Source Build** or **Package Usage** before initial setup ([docs/setup.md](docs/setup.md)).
- Do not create project-level agent configuration files outside [`.agents/skills/`](.agents/skills/).

## Progressive Disclosure

Read a document only when its topic is relevant to the current task:

- Architecture & behavioral contracts: [SPEC.md](SPEC.md)
- MCP tool schemas & response formats: [docs/mcp-tools.md](docs/mcp-tools.md)
- Runtime configuration & environment variables: [docs/configuration.md](docs/configuration.md)
- Setup choices & prerequisites: [docs/setup.md](docs/setup.md)
- Packaging & release distribution: [docs/distribution.md](docs/distribution.md)
- Metrics & Grafana dashboard: [docs/observability/README.md](docs/observability/README.md)
- Product requirements & roadmap: [REQUIREMENTS.md](REQUIREMENTS.md)

