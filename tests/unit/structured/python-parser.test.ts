import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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

const parsePythonSource = async (content: string) => {
  const bytes = Buffer.from(content, 'utf8');
  const parser = await new PythonLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath: 'inline.py', language: 'python', bytes, text: content });
  return result;
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

  it('supports PEP 695, docstrings, top-level async functions, and UTF-8 byte offsets', async () => {
    const { bytes, result, text } = await parsePythonFixture('exactness.py');
    const generic = result.declarations.find((item) => item.qualifiedName === 'generic');
    const unicode = result.declarations.find((item) => item.qualifiedName === '日本語');
    const unicodeStart = Buffer.byteLength(text.slice(0, text.indexOf('def 日本語')), 'utf8');
    const unicodeEnd = unicodeStart + Buffer.byteLength('def 日本語() -> str:\n    return "狐"', 'utf8');

    expect(generic?.rawSource).toContain('def generic[T](value: T) -> T:');
    expect(result.declarations.find((item) => item.qualifiedName === 'Service.fetch')?.rawSource).toContain('"""Return one cached value."""');
    expect(result.declarations.find((item) => item.qualifiedName === 'top_level_async')?.kind).toBe('function');
    expect(unicode?.startByte).toBe(unicodeStart);
    expect(unicode?.endByte).toBe(unicodeEnd);
    expect(unicode?.rawSource).toBe(decodeUtf8(bytes.subarray(unicodeStart, unicodeEnd)));
    expect(unicode?.sourceHash).toBe(sha256Hex(bytes.subarray(unicodeStart, unicodeEnd)));
  });

  it('reports aliases and relative imports while marking stars and shadowed names partial', async () => {
    const { result } = await parsePythonFixture('exactness.py');
    const imports = new Map(result.imports.map((item) => [item.bindingName, item]));

    expect(imports.get('alias')).toEqual(expect.objectContaining({ moduleSpecifier: 'package', completeness: 'complete' }));
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

  it('does not emit exact imports with syntax errors', async () => {
    const result = await parsePythonSource('from package import name as\n');

    expect(result.status).toBe('degraded');
    expect(result.imports).toEqual([]);
  });

  it('does not mark imports partial when later module-scope bindings reuse their names', async () => {
    const result = await parsePythonSource(`
from package import function, annotation, simple, left, loop_name
def function():
    pass
annotation: int
simple = 1
left, right = (1, 2)
for loop_name in []:
    pass
`.trim());
    const completenessByName = new Map(result.imports.map((item) => [item.bindingName, item.completeness]));

    expect(completenessByName).toEqual(new Map([
      ['function', 'complete'],
      ['annotation', 'complete'],
      ['simple', 'complete'],
      ['left', 'complete'],
      ['loop_name', 'complete'],
    ]));
  });

  it('marks imports partial only when earlier module-scope bindings shadow them', async () => {
    const result = await parsePythonSource(`
before = 1
if True:
    from_if = 1
try:
    from_try: int
except Exception:
    pass
with context():
    from_with = 1
while False:
    from_while = 1
for from_for in []:
    pass
from package import before, from_if, from_try, from_with, from_while, from_for, later
later = 1
`.trim());
    const completenessByName = new Map(result.imports.map((item) => [item.bindingName, item.completeness]));

    expect(completenessByName).toEqual(new Map([
      ['before', 'partial'],
      ['from_if', 'partial'],
      ['from_try', 'partial'],
      ['from_with', 'partial'],
      ['from_while', 'partial'],
      ['from_for', 'partial'],
      ['later', 'complete'],
    ]));
  });

  it('returns a partial result when structured source bytes are missing', async () => {
    const source = {
      filePath: 'missing-bytes.py',
      language: 'python',
      bytes: Buffer.from('def missing_bytes():\n    pass', 'utf8'),
      text: 'def missing_bytes():\n    pass',
    };
    Reflect.deleteProperty(source, 'bytes');
    const parser = await new PythonLanguagePlugin().createStructuredParser();
    const result = await parser.parseStructured(source);

    expect(result).toEqual(expect.objectContaining({
      status: 'degraded',
      retrievability: 'partial',
      failure: expect.objectContaining({ reasonCode: 'invariant_violation' }),
    }));
  });

  it('falls back when Tree-sitter cannot be loaded', async () => {
    vi.resetModules();
    vi.doMock('tree-sitter', () => {
      throw new Error('native parser unavailable');
    });

    try {
      const { PythonLanguagePlugin: IsolatedPythonLanguagePlugin } = await import('../../../src/plugins/languages/python.js');
      const parser = await new IsolatedPythonLanguagePlugin().createParser();
      const result = await parser.parse({ filePath: 'fallback.py', language: 'python', content: 'def fallback():\n    pass' });

      expect(result.declarations).toEqual([expect.objectContaining({ type: 'function', name: 'fallback' })]);
    } finally {
      vi.doUnmock('tree-sitter');
      vi.resetModules();
    }
  });
});
