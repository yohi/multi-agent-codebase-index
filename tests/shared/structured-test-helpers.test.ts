import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createTestNexusOptions } from './create-test-nexus-options.js';
import {
  createStructuredCoordinatorFixture,
  createStructuredSource,
} from './structured-test-helpers.js';

describe('structured test helpers', () => {
  it('preserves UTF-8 text and bytes in a structured source', () => {
    const source = createStructuredSource('src/café.ts', 'export const café = "狐";');

    expect(source.text).toBe('export const café = "狐";');
    expect(Buffer.from(source.bytes).toString('utf8')).toBe(source.text);
  });

  it('bootstraps the structured schema only when requested', async () => {
    const legacy = await createStructuredCoordinatorFixture();
    const structured = await createStructuredCoordinatorFixture({ bootstrapStructuredSchema: true });

    await expect(legacy.metadataStore.getStructuredIndexState()).resolves.toMatchObject({ schemaVersion: null });
    await expect(structured.metadataStore.getStructuredIndexState()).resolves.toMatchObject({ schemaVersion: 1 });
  });

  it('builds test server options for custom fixture content', async () => {
    const content = 'export function authenticate() { return true; }';
    const context = await createTestNexusOptions({
      projectRoot: process.cwd(),
      fileContent: content,
      chunkContent: content,
      bootstrapStructuredSchema: true,
    });

    expect(context.options.projectRoot).toBe(process.cwd());
    await expect(context.metadataStore.getStructuredIndexState()).resolves.toMatchObject({ schemaVersion: 1 });
    await expect(context.options.loadFileContent('src/auth.ts')).resolves.toBe(content);
  });

  it('uses OS-managed temporary directories in the structured retrieval benchmark', async () => {
    const benchmark = await readFile(
      new URL('../benchmarks/structured-retrieval.bench.ts', import.meta.url),
      'utf8',
    );

    expect(benchmark).not.toContain('Math.random()');
  });
});
