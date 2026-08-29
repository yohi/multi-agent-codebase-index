import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { decodeUtf8, sha256Hex } from '../../../src/structured/hash.js';

const fixturePath = (name: string): string => path.join('tests', 'fixtures', 'structured', 'typescript', name);

const parseText = async (filePath: string, text: string) => {
  const bytes = new TextEncoder().encode(text);
  const parser = await new TypeScriptLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'typescript', bytes, text });
  return { bytes, result, text };
};

const parseFixture = async (name: string) => {
  const filePath = fixturePath(name);
  const bytes = new Uint8Array(await readFile(filePath));
  const text = decodeUtf8(bytes);
  const parser = await new TypeScriptLanguagePlugin().createStructuredParser();
  const result = await parser.parseStructured({ filePath, language: 'typescript', bytes, text });
  return { bytes, result, text };
};

describe('TypeScript structured parser', () => {
  it('includes attached JSDoc before a decorator in the declaration range', async () => {
    const { bytes, result, text } = await parseFixture('exactness.ts');

    const method = result.declarations.find((item) => item.qualifiedName === 'Service.fetch');
    const docStart = text.indexOf('/** Fetches one user. */');

    expect(docStart).toBeGreaterThanOrEqual(0);
    expect(method?.rawSource?.startsWith('/** Fetches one user. */\n  @trace()\n  public async fetch')).toBe(true);
    expect(method?.startByte).toBe(Buffer.byteLength(text.slice(0, docStart), 'utf8'));
    expect(method?.sourceHash).toBe(sha256Hex(bytes.subarray(method?.startByte ?? 0, method?.endByte ?? 0)));
  });

  it('excludes JSDoc separated from a declaration by a blank line', async () => {
    const text = '/** Detached. */\r\n\r\nexport function documented(): void {}\r\n';

    const { result } = await parseText('blank-line.ts', text);
    const declaration = result.declarations.find((item) => item.qualifiedName === 'documented');

    expect(declaration?.rawSource).toBe('export function documented(): void {}');
    expect(declaration?.startByte).toBe(Buffer.byteLength('/** Detached. */\r\n\r\n', 'utf8'));
  });

  it('builds signatures without modifiers, decorators, bodies, or variable initializers', async () => {
    const { result } = await parseFixture('exactness.ts');

    const method = result.declarations.find((item) => item.qualifiedName === 'Service.fetch');
    const value = result.declarations.find((item) => item.qualifiedName === 'value');
    const typed = result.declarations.find((item) => item.qualifiedName === 'typed');
    const genericTyped = result.declarations.find((item) => item.qualifiedName === 'genericTyped');

    expect(method?.signatureDiscriminator).toBe('fetch ( id : string ) : Promise < string >');
    expect(value?.signatureDiscriminator).toBe('const value');
    expect(typed?.signatureDiscriminator).toBe('const typed : { readonly label : string }');
    expect(genericTyped?.signatureDiscriminator).toBe('const genericTyped : < T = string > ( value : T ) => T');
  });

  it('keeps signatures stable across formatting and comments', async () => {
    const compact = 'export async function formatMe(value: { readonly label: "x" }): Promise<{ readonly ok: true }> { return { ok: true }; }';
    const formatted = `export /* trivia */ async function formatMe(
  value /* comment */: {
    readonly label: "x"
  }
): Promise<{
  readonly ok: true
}> {
  return { ok: true };
}`;

    const compactResult = await parseText('compact.ts', compact);
    const formattedResult = await parseText('formatted.ts', formatted);
    const compactSignature = compactResult.result.declarations.find((item) => item.name === 'formatMe')?.signatureDiscriminator;
    const formattedSignature = formattedResult.result.declarations.find((item) => item.name === 'formatMe')?.signatureDiscriminator;

    expect(compactSignature).toBe('function formatMe ( value : { readonly label : "x" } ) : Promise < { readonly ok : true } >');
    expect(formattedSignature).toBe(compactSignature);
  });

  it('normalizes identifiers to NFC while preserving literal source text', async () => {
    const decomposedName = 'cafe\u0301';
    const text = String.raw`export function ${decomposedName}(value: "e\x78act"): "e\x78act" { return value; }`;

    const { result } = await parseText('unicode.ts', text);

    expect(result.declarations[0]?.signatureDiscriminator).toBe('function café ( value : "e\\x78act" ) : "e\\x78act"');
  });

  it('emits constructors, default declarations, and variable-assigned functions', async () => {
    const { result } = await parseFixture('coverage.ts');
    const byName = new Map(result.declarations.map((item) => [item.qualifiedName, item]));

    expect(byName.get('Outer.Inner.constructor')).toEqual(expect.objectContaining({ name: 'constructor', kind: 'constructor' }));
    expect(byName.get('default')).toEqual(expect.objectContaining({ name: 'default', kind: 'class' }));
    expect(byName.get('arrow')).toEqual(expect.objectContaining({ name: 'arrow', kind: 'function' }));
    expect(byName.get('expression')).toEqual(expect.objectContaining({ name: 'expression', kind: 'function' }));
  });

  it.each([
    ['function', 'export default function (): void {}', 'function'],
    ['class', 'export default class {}', 'class'],
  ] as const)('emits an anonymous default %s with the name default', async (_label, text, kind) => {
    const { result } = await parseText(`anonymous-default-${kind}.ts`, text);

    expect(result.declarations).toContainEqual(expect.objectContaining({ qualifiedName: 'default', name: 'default', kind }));
  });

  it('does not issue exact declarations for multi-declarators or destructuring', async () => {
    const { result } = await parseFixture('coverage.ts');
    const names = new Set(result.declarations.map((item) => item.qualifiedName));

    expect(names.has('first')).toBe(false);
    expect(names.has('second')).toBe(false);
    expect(names.has('destructured')).toBe(false);
  });

  it('resolves namespace import aliases as complete bindings', async () => {
    const { result } = await parseFixture('coverage.ts');

    expect(result.imports).toContainEqual(expect.objectContaining({ bindingName: 'dependency', completeness: 'complete' }));
  });

  it('marks imports shadowed by top-level declarations partial', async () => {
    const text = "import { value } from './dependency.js';\nconst value = 2;\nexport function use(): number { return value; }\n";

    const { result } = await parseText(fixturePath('shadowed-inline.ts'), text);

    expect(result.imports).toContainEqual(expect.objectContaining({ bindingName: 'value', completeness: 'partial' }));
  });

  it('marks imports from unresolvable module specifiers partial', async () => {
    const text = "import { missing } from './does-not-exist.js';\nexport const value = missing;\n";

    const { result } = await parseText('unresolved.ts', text);

    expect(result.imports).toContainEqual(expect.objectContaining({ bindingName: 'missing', completeness: 'partial' }));
  });

  it('assigns distinct IDs to overload signatures and their implementation', async () => {
    const { result } = await parseFixture('coverage.ts');
    const overloads = result.declarations.filter((item) => item.qualifiedName === 'overloaded');

    expect(overloads).toHaveLength(3);
    expect(new Set(overloads.map((item) => item.signatureDiscriminator)).size).toBe(3);
    expect(new Set(overloads.map((item) => item.symbolId)).size).toBe(3);
  });

  it('downgrades syntax errors and withholds IDs for affected declarations', async () => {
    const { result } = await parseFixture('malformed.ts');

    expect(result.status).toBe('degraded');
    expect(result.retrievability).toBe('partial');
    expect(result.declarations.find((item) => item.qualifiedName === 'ValidClass')?.symbolId).toMatch(/^symbol_v1_/);
    expect(result.declarations.find((item) => item.qualifiedName === 'BrokenClass')?.symbolId).toBeUndefined();
  });

  it('extracts the required declaration families and Unicode names', async () => {
    const { result } = await parseFixture('coverage.ts');
    const names = new Set(result.declarations.map((item) => item.qualifiedName));

    expect(names.has('Outer.Inner')).toBe(true);
    expect(names.has('Alias')).toBe(true);
    expect(names.has('State')).toBe(true);
    expect(names.has('default')).toBe(true);
    expect(names.has('日本語')).toBe(true);
  });
});
