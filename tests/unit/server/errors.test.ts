import { describe, expect, it } from 'vitest';

import { classifyErrorMessage } from '../../../src/server/errors.js';

describe('classifyErrorMessage', () => {
  it('maps invalid line ranges to NEXUS_CONTENT_NOT_FOUND', () => {
    expect(classifyErrorMessage('Invalid line range: startLine (5) is greater than endLine (2)')).toBe(
      'NEXUS_CONTENT_NOT_FOUND',
    );
  });

  it('maps ENOENT-style messages to NEXUS_CONTENT_NOT_FOUND', () => {
    expect(classifyErrorMessage("ENOENT: no such file or directory, open 'x.ts'")).toBe(
      'NEXUS_CONTENT_NOT_FOUND',
    );
  });

  it('maps dimension mismatch messages to NEXUS_VECTOR_DIMENSION_MISMATCH', () => {
    expect(classifyErrorMessage('vector dimension 64 does not match 128')).toBe(
      'NEXUS_VECTOR_DIMENSION_MISMATCH',
    );
  });

  it('maps reindex-in-progress messages to NEXUS_INDEXING_IN_PROGRESS', () => {
    expect(classifyErrorMessage('already_running')).toBe('NEXUS_INDEXING_IN_PROGRESS');
    expect(classifyErrorMessage('Reindex already running: incremental')).toBe('NEXUS_INDEXING_IN_PROGRESS');
  });

  it('returns undefined for unclassified messages', () => {
    expect(classifyErrorMessage('boom')).toBeUndefined();
  });
});
