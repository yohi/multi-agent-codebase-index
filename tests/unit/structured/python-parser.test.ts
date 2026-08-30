import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PythonLanguagePlugin } from '../../../src/plugins/languages/python.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const fixturePath = (name: string): string => path.join('tests', 'fixtures', 'structured', 'python', name);

const parsePythonFixture = async (name: string) => {
  const filePath = fixturePath(name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new PythonLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'python', bytes, text });
  return { bytes, result, text };
};

describe('Python structured parser', () => {
  it('includes only same-indent decorators and excludes preceding hash comments', async () => {
    const { result } = await parsePythonFixture('exactness.py');
    const decorated = result.declarations.find((item) => item.qualifiedName === 'Service.fetch');

    expect(decorated?.rawSource).toMatch(/^@cache\n    async def fetch/);
    expect(decorated?.rawSource).not.toContain('# unrelated');
  });

  it('does not create exact symbols for nested functions or destructuring assignments', async () => {
    const { result } = await parsePythonFixture('exactness.py');
    const qualifiedNames = result.declarations.map((item) => item.qualifiedName);
    const names = result.declarations.map((item) => item.name);

    expect(qualifiedNames).not.toContain('outer.inner');
    expect(names).not.toContain('left');
  });

  it('keeps independent declarations exact when a later declaration is malformed', async () => {
    const { result } = await parsePythonFixture('exactness.py');

    expect(result.status).toBe('degraded');
    expect(result.retrievability).toBe('partial');
    expect(result.declarations.find((item) => item.qualifiedName === 'Service')?.symbolId).toMatch(/^symbol_v1_/);
    expect(result.declarations.find((item) => item.qualifiedName === 'Broken')).toBeUndefined();
  });

  it('supports PEP 695, docstrings, and UTF-8 byte offsets', async () => {
    const { bytes, result, text } = await parsePythonFixture('exactness.py');
    const generic = result.declarations.find((item) => item.qualifiedName === 'generic');
    const unicode = result.declarations.find((item) => item.qualifiedName === '日本語');
    const unicodeStart = text.indexOf('def 日本語');

    expect(generic?.rawSource).toContain('def generic[T](value: T) -> T:');
    expect(result.declarations.find((item) => item.qualifiedName === 'Service.fetch')?.rawSource).toContain('"""Return one cached value."""');
    expect(unicode?.startByte).toBe(Buffer.byteLength(text.slice(0, unicodeStart), 'utf8'));
    expect(unicode?.sourceHash).toBe(sha256Hex(bytes.subarray(unicode?.startByte ?? 0, unicode?.endByte ?? 0)));
  });

  it('reports aliases and relative imports while marking stars and shadowed names partial', async () => {
    const { result } = await parsePythonFixture('exactness.py');
    const imports = new Map(result.imports.map((item) => [item.bindingName, item]));

    expect(imports.get('alias')).toEqual(expect.objectContaining({ moduleSpecifier: 'package', completeness: 'partial' }));
    expect(imports.get('local')).toEqual(expect.objectContaining({ moduleSpecifier: '.relative', completeness: 'complete' }));
    expect(imports.get('module_alias')).toEqual(expect.objectContaining({ moduleSpecifier: 'module', completeness: 'complete' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ bindingName: undefined, moduleSpecifier: 'package', completeness: 'partial' }));
  });

  it('links duplicate class methods to their containing declaration', async () => {
    const { result } = await parsePythonFixture('exactness.py');
    const classes = result.declarations.filter((item) => item.qualifiedName === 'Duplicate');
    const firstClass = classes.find((item) => item.rawSource?.includes('def first'));
    const secondClass = classes.find((item) => item.rawSource?.includes('def second'));
    const firstMethod = result.declarations.find((item) => item.qualifiedName === 'Duplicate.first');
    const secondMethod = result.declarations.find((item) => item.qualifiedName === 'Duplicate.second');

    expect(firstClass).toBeDefined();
    expect(secondClass).toBeDefined();
    expect(firstMethod?.parentSymbolId).toBe(firstClass?.symbolId);
    expect(secondMethod?.parentSymbolId).toBe(secondClass?.symbolId);
  });
});
