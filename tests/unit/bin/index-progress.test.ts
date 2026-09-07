import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readIndexProgress } from '../../../src/bin/index-progress.js';

describe('readIndexProgress', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('reads current indexing progress from the managed metrics endpoint', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-progress-'));
    await writeFile(path.join(tempDir, 'metrics.port'), '43210\n', 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { name: 'nexus_indexing_active', values: [{ value: 1 }] },
            { name: 'nexus_indexing_processed_files', values: [{ value: 12 }] },
            { name: 'nexus_indexing_total_files', values: [{ value: 100 }] },
          ]),
          { status: 200 },
        ),
      ),
    );

    await expect(readIndexProgress(tempDir)).resolves.toEqual({
      active: true,
      processedFiles: 12,
      totalFiles: 100,
    });
  });

  it('returns undefined when the managed metrics endpoint is unavailable', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-progress-'));
    await writeFile(path.join(tempDir, 'metrics.port'), '43210\n', 'utf8');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    await expect(readIndexProgress(tempDir)).resolves.toBeUndefined();
  });

  it('returns undefined when the metrics port file cannot be read', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-progress-'));
    await mkdir(path.join(tempDir, 'metrics.port'));

    await expect(readIndexProgress(tempDir)).resolves.toBeUndefined();
  });
});
