import { describe, expect, it } from 'vitest';

import {
  GET_CONTEXT_DEFINITION,
  TOOL_DEFINITIONS,
} from '../../../../../src/server/tools/registry/definitions.js';

describe('tool definitions', () => {
  it('contains the 6 known tools in registration order', () => {
    expect(TOOL_DEFINITIONS.map((definition) => definition.name)).toEqual([
      'semantic_search',
      'grep_search',
      'hybrid_search',
      'get_context',
      'index_status',
      'reindex',
    ]);
  });

  it('mirrors the legacy get_context schema', () => {
    expect(GET_CONTEXT_DEFINITION.input.mode).toEqual({
      kind: 'enum',
      values: ['eager', 'deferred'],
      optional: true,
      default: 'eager',
      description:
        'Set to "deferred" to receive a short preview and hint instead of full content for large files.',
    });
  });

  it('caps topK and maxResults with v2 maximums', () => {
    const hybrid = TOOL_DEFINITIONS.find((definition) => definition.name === 'hybrid_search');
    const grep = TOOL_DEFINITIONS.find((definition) => definition.name === 'grep_search');
    expect(hybrid?.input.topK).toMatchObject({ kind: 'integer', maximum: 100 });
    expect(grep?.input.maxResults).toMatchObject({ kind: 'integer', maximum: 1000 });
  });
});
