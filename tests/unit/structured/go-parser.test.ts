import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoLanguagePlugin } from '../../../src/plugins/languages/go.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const fixturePath = (name: string): string => path.join('tests', 'fixtures', 'structured', 'go', name);

const parseGoFixture = async (name: string) => {
  const filePath = fixturePath(name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new GoLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'go', bytes, text });
  return { bytes, result, text };
};

describe('Go structured parser', () => {
  it('uses owner-qualified interface methods with distinct public IDs', async () => {
    const { result } = await parseGoFixture('exactness.go');
    const reader = result.declarations.find((item) => item.qualifiedName === 'Reader.Read')!;
    const writer = result.declarations.find((item) => item.qualifiedName === 'Writer.Read')!;

    expect(reader.symbolId).not.toBe(writer.symbolId);
    expect(reader.parentSymbolId).toBeDefined();
    expect(writer.parentSymbolId).toBeDefined();
    expect(reader.parentSymbolId).not.toBe(writer.parentSymbolId);
  });

  it('includes adjacent Go doc comments and directives but excludes comments after a blank line', async () => {
    const { result, text } = await parseGoFixture('exactness.go');
    const open = result.declarations.find((item) => item.name === 'Open')!;

    expect(open.rawSource).toContain('//go:noinline');
    expect(open.rawSource).toContain('// Open opens a resource.');
    expect(open.rawSource).not.toContain('Reader is a reader interface');

    const docStart = text.indexOf('//go:noinline');
    expect(open.startByte).toBe(Buffer.byteLength(text.slice(0, docStart), 'utf8'));
  });

  it('links receiver methods to their owning type', async () => {
    const { result } = await parseGoFixture('exactness.go');
    const close = result.declarations.find((item) => item.qualifiedName === 'Resource.Close')!;

    expect(close.parentSymbolId).toBeDefined();
    expect(close.rawSource).toContain('func (r *Resource) Close() error');
  });

  it('includes exported standalone functions only', async () => {
    const { result } = await parseGoFixture('exactness.go');
    const names = new Set(result.declarations.map((item) => item.qualifiedName));

    expect(names.has('Open')).toBe(true);
    expect(names.has('unexportedHelper')).toBe(false);
  });

  it('emits single and grouped type aliases as typeAlias declarations', async () => {
    const text = [
      'package aliases',
      '',
      'type Alias = string',
      '',
      'type (',
      '\tGroupedAlias = Alias',
      '\tAnotherAlias = map[string]Alias',
      ')',
    ].join('\n');
    const bytes = new TextEncoder().encode(text);
    const parser = await new GoLanguagePlugin().createStructuredParser();
    const result = await parser.parseStructured({ filePath: 'aliases.go', language: 'go', bytes, text });

    expect(result.declarations.filter((item) => item.kind === 'typeAlias').map((item) => item.name)).toEqual([
      'Alias',
      'GroupedAlias',
      'AnotherAlias',
    ]);
  });

  it('exports standalone functions only when the first Unicode code point is uppercase', async () => {
    const uppercaseAstral = String.fromCodePoint(0x10400);
    const lowercaseAstral = String.fromCodePoint(0x10428);
    const text = [
      'package names',
      '',
      'func _helper() {}',
      'func \u65e5\u672c\u8a9e() {}',
      `func ${uppercaseAstral}Exported() {}`,
      `func ${lowercaseAstral}unexported() {}`,
      'func Exported() {}',
    ].join('\n');
    const bytes = new TextEncoder().encode(text);
    const parser = await new GoLanguagePlugin().createStructuredParser();
    const result = await parser.parseStructured({ filePath: 'unicode.go', language: 'go', bytes, text });
    const names = new Set(result.declarations.map((item) => item.qualifiedName));

    expect(names).toEqual(new Set(['Exported', `${uppercaseAstral}Exported`]));
  });

  it('hashes symbol source from exact UTF-8 byte slices', async () => {
    const { bytes, result } = await parseGoFixture('exactness.go');
    const open = result.declarations.find((item) => item.name === 'Open')!;

    expect(open.sourceHash).toBe(sha256Hex(bytes.subarray(open.startByte, open.endByte)));
    expect(open.rawSource).toBe(decodeUtf8(bytes.subarray(open.startByte, open.endByte)));
  });

  it('returns a partial result when structured source bytes are missing', async () => {
    const parser = await new GoLanguagePlugin().createStructuredParser();
    const result = await parser.parseStructured({ filePath: 'src/x.go', language: 'go', bytes: undefined as unknown as Uint8Array, text: 'package x' });

    expect(result.status).toBe('degraded');
    expect(result.failure?.reasonCode).toBe('invariant_violation');
  });

  it('reports degraded for malformed syntax and withholds IDs for affected declarations', async () => {
    const { result } = await parseGoFixture('malformed.go');

    expect(result.status).toBe('degraded');
    expect(result.declarations.find((item) => item.qualifiedName === 'Broken')?.symbolId).toBeUndefined();
  });
});
