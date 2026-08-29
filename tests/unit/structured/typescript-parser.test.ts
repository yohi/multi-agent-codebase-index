import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { sha256Hex } from '../../../src/structured/hash.js';

describe('TypeScript structured parser', () => {
  it('produces nested exact declarations and byte hashes from original bytes', async () => {
    const filePath = path.join('tests', 'fixtures', 'structured', 'typescript', 'exactness.ts');
    const bytes = new Uint8Array(await readFile(filePath));
    const parser = await (new TypeScriptLanguagePlugin()).createStructuredParser();
    const result = await parser.parseStructured({ filePath, language: 'typescript', bytes, text: new TextDecoder().decode(bytes) });
    const method = result.declarations.find((item) => item.qualifiedName === 'Service.fetch');
    expect(method?.isExact).toBe(true);
    expect(method?.sourceHash).toBe(sha256Hex(bytes.subarray(method?.startByte ?? 0, method?.endByte ?? 0)));
    expect(method?.rawSource).toContain('public async fetch');
    expect(new Set(result.declarations.map((item) => item.symbolId)).size).toBe(result.declarations.length);
  });
});
