import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// When running under a git worktree, __dirname may be inside .worktrees/.../feat/branch,
// so locate the project root by walking up until package.json is found instead of assuming
// a fixed number of parent directories.
const findProjectRoot = (start: string): string => {
  let current = start;
  while (current !== "/") {
    try {
      readFileSync(join(current, "package.json"), "utf-8");
      return current;
    } catch {
      const parent = join(current, "..");
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error(`Could not find project root from ${start}`);
};

const PROJECT_ROOT = findProjectRoot(__dirname);

function readGuidanceFile(filePath: string): string {
  return readFileSync(join(PROJECT_ROOT, filePath), "utf-8");
}

const GUIDANCE_FILES = {
  readme: "README.md",
  spec: "SPEC.md",
  mcpTools: "docs/mcp-tools.md",
  skill: ".agents/skills/code-search.md",
} as const;

describe("structured-retrieval guidance (AC-17)", () => {
  const readme = readGuidanceFile(GUIDANCE_FILES.readme);
  const spec = readGuidanceFile(GUIDANCE_FILES.spec);
  const mcpTools = readGuidanceFile(GUIDANCE_FILES.mcpTools);
  const skill = readGuidanceFile(GUIDANCE_FILES.skill);

  it("documents symbol-aware retrieval flow in README", () => {
    expect(readme).toContain("semantic_search");
    expect(readme).toContain("hybrid_search");
    expect(readme).toContain("get_symbol_source");
    expect(readme).toContain("get_symbol_context");
    expect(readme).toContain("get_file_outline");
    expect(readme).toContain("chunk.symbolId");
    expect(readme).toContain("Structured symbol retrieval");
    expect(readme).toContain("get_context");
  });

  it("documents the canonical flow in docs/mcp-tools.md", () => {
    expect(mcpTools).toContain("semantic_search / hybrid_search result with symbolId");
    expect(mcpTools).toContain("-> get_symbol_source or get_symbol_context");
    expect(mcpTools).toContain("known supported file");
    expect(mcpTools).toContain("-> get_file_outline");
    expect(mcpTools).toContain("-> get_symbol_source or get_symbol_context");
  });

  it("documents full-rebuild upgrade requirement and status matrix", () => {
    expect(mcpTools).toContain("reindex({ fullRebuild: true })");
    expect(mcpTools).toContain("STRUCTURED_INDEX_MISSING");
    expect(mcpTools).toContain("INDEX_FILE_HASH_MISMATCH");
    expect(mcpTools).toContain("stale_identity");
  });

  it("preserves get_context exceptions in skill guidance", () => {
    expect(skill).toContain("get_symbol_source");
    expect(skill).toContain("get_symbol_context");
    expect(skill).toContain("get_file_outline");
    expect(skill).toContain("get_context");
  });

  it("retains CodeGraph guidance unchanged", () => {
    expect(skill).toContain(".codegraph/");
    expect(skill).toContain("codegraph_explore");
  });

  it("documents structured retrieval contract in SPEC.md", () => {
    expect(spec).toContain("get_file_outline");
    expect(spec).toContain("get_symbol_source");
    expect(spec).toContain("get_symbol_context");
    expect(spec).toContain("symbol_v1_");
    expect(spec).toContain("reindex({ fullRebuild: true })");
    expect(spec).toContain("INDEX_FILE_HASH_MISMATCH");
  });
});
