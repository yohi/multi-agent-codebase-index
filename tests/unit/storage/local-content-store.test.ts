import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import { LocalContentStoreFactory } from '../../../src/storage/local/local-content-store.js';

describe('LocalContentStore', () => {
  let root: string;
  let factory: LocalContentStoreFactory;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nexus-content-store-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'l1\nl2\nl3\n');
    const sanitizer = await PathSanitizer.create(root);
    factory = new LocalContentStoreFactory({
      projectRoot: root,
      sanitize: (filePath) => sanitizer.sanitize(filePath),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns the requested inclusive line range', async () => {
    const store = factory.getStore('ws', 'rev');
    await expect(store.readRange('src/a.ts', 2, 3)).resolves.toBe('l2\nl3');
  });

  it('clamps out-of-range bounds to file boundaries', async () => {
    const store = factory.getStore('ws', 'rev');
    await expect(store.readRange('src/a.ts', 1, Number.MAX_SAFE_INTEGER)).resolves.toBe('l1\nl2\nl3\n');
  });

  it('rejects a line range whose start exceeds its end', async () => {
    const store = factory.getStore('ws', 'rev');
    await expect(store.readRange('src/a.ts', 3, 2)).rejects.toThrow(/^Invalid line range:/);
  });

  it('rejects paths outside the project root', async () => {
    const store = factory.getStore('ws', 'rev');
    await expect(store.readRange('../outside.ts', 1, 1)).rejects.toThrow();
  });

  it('leaves hash-addressed methods for Phase 4', async () => {
    const store = factory.getStore('ws', 'rev');
    await expect(store.get('abc')).resolves.toBeNull();
    await expect(store.exists('abc')).resolves.toBe(false);
    await expect(store.put('abc', new Uint8Array())).rejects.toThrow(/not implemented/);
    await expect(store.delete('abc')).rejects.toThrow(/not implemented/);
  });

  it('requires non-empty scope identifiers', () => {
    expect(() => factory.getStore('', 'rev')).toThrow(/workspaceId/);
    expect(() => factory.getStore('ws', '')).toThrow(/revisionId/);
  });
});
