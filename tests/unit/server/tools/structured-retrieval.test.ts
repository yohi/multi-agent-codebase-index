import { describe, expect, it } from 'vitest';

import { buildToolHandlers } from '../../../../src/server/tools/tool-support.js';
import { createTestNexusOptions } from '../../../shared/create-test-nexus-options.js';

describe('structured retrieval tool handlers', () => {
  it('get_file_outline returns not-ready status when structured index is empty', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers(options);
    const result = await handlers.get_file_outline({ filePath: 'src/auth.ts' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: expect.any(String),
    });
  });

  it('get_symbol_source returns not-ready status when symbol is unknown', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers(options);
    const result = await handlers.get_symbol_source({ symbolId: 'unknown' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: expect.any(String),
    });
  });

  it('get_symbol_context returns not-ready status when symbol is unknown', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers(options);
    const result = await handlers.get_symbol_context({ symbolId: 'unknown', tokenBudget: 512 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: expect.any(String),
    });
  });

  it('structured handlers return error when service is unavailable', async () => {
    const { options } = await createTestNexusOptions();
    const handlers = buildToolHandlers({ ...options, symbolRetrievalService: undefined });
    const outline = await handlers.get_file_outline({ filePath: 'src/auth.ts' });
    const source = await handlers.get_symbol_source({ symbolId: 'x' });
    const context = await handlers.get_symbol_context({ symbolId: 'x', tokenBudget: 128 });
    for (const result of [outline, source, context]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: true });
    }
  });
});
