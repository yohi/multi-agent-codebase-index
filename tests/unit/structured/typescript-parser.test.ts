import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

describe('TypeScript structured parser', () => {
  it('produces nested exact declarations and byte hashes from original bytes', async () => {
    const filePath = path.join('tests', 'fixtures', 'structured', 'typescript', 'exactness.ts');
    const bytes = new Uint8Array(await readFile(filePath));
    const parser = await (new TypeScriptLanguagePlugin()).createStructuredParser();
    const result = await parser.parseStructured({ filePath, language: 'typescript', bytes, text: decodeUtf8(bytes) });
    const method = result.declarations.find((item) => item.qualifiedName === 'Service.fetch');
    expect(method?.isExact).toBe(true);
    expect(method?.sourceHash).toBe(sha256Hex(bytes.subarray(method?.startByte ?? 0, method?.endByte ?? 0)));
    expect(method?.rawSource).toContain('public async fetch');
    expect(new Set(result.declarations.map((item) => item.symbolId)).size).toBe(result.declarations.length);
    expect(result.declarations.every((item) => item.symbolId?.match(/^symbol_v1_[A-Za-z0-9_-]{43}$/))).toBe(true);
  });

  it('downgrades syntax errors and withholds IDs for affected declarations', async () => {
    const filePath = path.join('tests', 'fixtures', 'structured', 'typescript', 'malformed.ts');
    const bytes = new Uint8Array(await readFile(filePath));
    const parser = await (new TypeScriptLanguagePlugin()).createStructuredParser();
    const result = await parser.parseStructured({ filePath, language: 'typescript', bytes, text: decodeUtf8(bytes) });
    expect(result.status).toBe('degraded');
    expect(result.retrievability).toBe('partial');
    expect(result.declarations.find((item) => item.qualifiedName === 'ValidClass')?.symbolId).toMatch(/^symbol_v1_/);
    expect(result.declarations.find((item) => item.qualifiedName === 'BrokenClass')?.symbolId).toBeUndefined();
  });
});
