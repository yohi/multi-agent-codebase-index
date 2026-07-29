# Code Search Skill

## When to load

Load this skill before any code investigation or design exploration. Trigger phrases include:

- "Where is this implemented?", "find the reindex logic", or "locate the relevant code".
- "Who calls `<symbol>`?", "show the call sites", or "trace this symbol".
- "〜を調べて", "〜の実装を探して", or "〜の影響範囲を知りたい".
- "How does this feature work?", architecture questions, and dependency exploration.
- "Search the codebase", "find an example", or any request to inspect implementation details.

Do not return a search-only answer when the task requires understanding code. Follow the pipeline below.

## Standard pipeline

Use this order for every code-search task:

**task classification → choose index → get context → act**

This is an agent procedure, not a Nexus MCP prerequisite. Nexus accepts its tools
in any order, so clients that call tools directly are not blocked by this sequence.

1. **Task classification**
   - Vague, conceptual, or architectural request: identify concepts and likely related areas.
   - Exact symbol, error, string, or code fragment: preserve the exact search term.
   - Structural or call-tree request: determine whether CodeGraph is available.
2. **Choose index**
   - Call Nexus `index_status` before any Nexus search. If indexing is running, treat results as potentially incomplete.
   - Use `codegraph_explore` for structural tracing only when the project has a `.codegraph/` directory.
   - Without a CodeGraph index, trace structural requests with `index_status`, then Nexus `hybrid_search` and `get_context`.
   - Use Nexus `hybrid_search` for vague or conceptual exploration.
   - Use Nexus `grep_search` for exact symbols, errors, and strings.
   - If a branch switch or large file change may have made the index stale, call `reindex` before relying on search results.
3. **Get context**
   - Retrieve the smallest useful line ranges with Nexus `get_context` using both `startLine` and `endLine`.
   - Prefer the definition, its callers, and the surrounding control flow over whole-file reads.
4. **Act**
   - Explain the relevant path, answer the question, or make the requested change using the retrieved context.
   - Include file paths and line ranges so the result can be checked without another broad search.

## One-Call pattern

After a search returns candidates, call `get_context` for the top candidates before
returning search results. Select the most relevant one to three candidates, request
targeted line ranges, and use those snippets to validate relevance. The first
response should contain an actionable answer or a grounded summary, not only a list
of search hits. This pattern may use multiple MCP calls, but produces one
evidence-based agent response.

For a vague query, the normal sequence is:

1. `index_status`
2. `hybrid_search`
3. `get_context` for the top candidates with explicit line ranges
4. Return the concise finding with file and line references

For an exact query, replace `hybrid_search` with `grep_search`. For a structural query, use `codegraph_explore` when `.codegraph/` exists, then use `get_context` when Nexus context is needed.

## Deferred Loading

Return a summary and file/line numbers first. Expand the explanation or retrieve additional context only when the user asks for details, the initial snippets are insufficient, or an edit requires more surrounding code. Keep the initial context bounded by `startLine` and `endLine`; never load an entire file through `get_context` merely to provide background.

When expanding, request the next smallest relevant range rather than repeating the full search. Preserve the original candidate paths and line numbers so deferred results remain traceable.

## Nexus MCP usage rules

Nexus is a local-first code indexing platform that combines semantic search, ripgrep search, and AST-based context parsing.

- **Index status:** Always run `index_status` before searching. If `pipelineProgress.status === 'running'`, search results may be incomplete.
- **Search strategy:** Use `hybrid_search` for semantic queries, vague feature exploration, or architectural questions; it combines vector and ripgrep results through RRF.
- **Exact search:** Use `grep_search` to pinpoint exact symbols, class or function names, error messages, and code fragments.
- **Context budgeting:** Use `get_context` with explicit `startLine` and `endLine` values. Do not read a whole file when a minimal snippet answers the question.
- **Index freshness:** After switching branches or making massive code changes, call `reindex` to refresh the local index before relying on semantic results.
- **Project context:** When Nexus is active, consult `SPEC.md` for architecture details and `AGENTS.md` for project constraints when those details affect the task.

All exploration should remain local-first. Do not introduce external data transmission as part of code search unless the user explicitly requests it.

## Verification examples

Use the following scenarios to confirm that the standard pipeline, One-Call pattern, and tool triggers are applied correctly.

### 1. Vague feature search

**User input:** "Where is the reindex logic implemented?"

**Expected tool sequence:**
1. Load this skill (`code-search.md`).
2. Call `index_status` to confirm the index is ready.
3. Call `hybrid_search` with a query like `reindex logic`.
4. Call `get_context` for the top 1–3 candidates with explicit `startLine` and `endLine`.

**Success criteria:**
- `hybrid_search` is chosen instead of `grep_search`.
- The final answer includes the implementation file path(s) and the line ranges retrieved via `get_context`.
- The answer explains the reindex logic using the retrieved snippets, not just a list of search hits.

### 2. Exact symbol trace

**User input:** "Who calls `executeHybridSearch`?"

**Expected tool sequence:**
1. Load this skill (`code-search.md`).
2. Call `index_status` to confirm the index is ready.
3. Call `grep_search` for the exact symbol `executeHybridSearch`.
4. Call `get_context` for each call site with explicit line ranges.

**Success criteria:**
- `grep_search` uses the exact symbol name as the query.
- The final answer lists every call site with file path and line number.
- The answer distinguishes callers from the definition itself.

### 3. Structural call-tree request

**User input:** "Show me the dependency graph of the search module."

**Expected tool sequence (if `.codegraph/` exists):**
1. Load this skill (`code-search.md`).
2. Call `codegraph_explore` for the search module structure.
3. Use `get_context` to retrieve key line ranges that support the reported graph.

**Expected tool sequence (if `.codegraph/` does not exist):**
1. Load this skill (`code-search.md`).
2. Call `index_status` to confirm the index is ready.
3. Call `hybrid_search` to explore files under the `search/` directory or related symbols.
4. Call `get_context` for relevant results.

**Success criteria:**
- The tool choice branches on the presence of `.codegraph/`.
- `codegraph_explore` is never called when `.codegraph/` is absent.
- The final answer includes module dependencies and the evidence paths.
