import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';

import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile, SymbolKind } from '../../types/index.js';
import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredImport,
  StructuredLanguageParser,
  StructuredParseResult,
  StructuredSource,
} from '../../structured/contracts.js';
import { decodeUtf8, sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';

type DeclarationCandidate = {
  readonly declaration: Parser.SyntaxNode;
  readonly range: Parser.SyntaxNode;
  readonly kind: 'class' | 'function' | 'method';
  readonly parents: readonly string[];
  readonly scope?: Parser.SyntaxNode;
};

type ImportBinding = { readonly moduleSpecifier: string; readonly bindingName?: string; readonly partial: boolean };

const textEncoder = new TextEncoder();

const isDeclaration = (node: Parser.SyntaxNode): boolean =>
  node.type === 'class_definition' || node.type === 'function_definition' || node.type === 'async_function_definition';

const definitionFor = (node: Parser.SyntaxNode): { readonly declaration: Parser.SyntaxNode; readonly range: Parser.SyntaxNode } | undefined => {
  if (isDeclaration(node)) return { declaration: node, range: node };
  if (node.type !== 'decorated_definition') return undefined;
  const definition = node.childForFieldName('definition');
  return definition && isDeclaration(definition) ? { declaration: definition, range: node } : undefined;
};

const nameFor = (node: Parser.SyntaxNode): string | undefined => node.childForFieldName('name')?.text;

const hasSyntaxProblem = (node: Parser.SyntaxNode): boolean => node.hasError || node.isMissing;

const diagnosticsFor = (node: Parser.SyntaxNode): readonly string[] => {
  const diagnostics: string[] = [];
  const visit = (current: Parser.SyntaxNode): void => {
    if (current.isError || current.isMissing) diagnostics.push(`${current.type} at ${current.startPosition.row + 1}:${current.startPosition.column}`);
    for (const child of current.children) visit(child);
  };
  visit(node);
  return diagnostics;
};

const positionFor = (node: Parser.SyntaxNode) => ({ startLine: node.startPosition.row + 1, startColumn: node.startPosition.column, endLine: node.endPosition.row + 1, endColumn: node.endPosition.column });

const rawSourceFor = (bytes: Uint8Array, startByte: number, endByte: number): string => decodeUtf8(bytes.subarray(startByte, endByte));

const signatureFor = (bytes: Uint8Array, node: Parser.SyntaxNode): string => {
  const body = node.childForFieldName('body');
  return decodeUtf8(bytes.subarray(node.startIndex, body?.startIndex ?? node.endIndex)).replace(/\s+/gu, ' ').trim();
};

const candidatesFor = (root: Parser.SyntaxNode): readonly DeclarationCandidate[] => {
  const candidates: DeclarationCandidate[] = [];
  for (const child of root.namedChildren) {
    const definition = definitionFor(child);
    if (!definition) continue;
    const name = nameFor(definition.declaration);
    if (!name) continue;
    if (definition.declaration.type === 'class_definition') {
      candidates.push({ ...definition, kind: 'class', parents: [] });
      const block = definition.declaration.childForFieldName('body');
      for (const member of block?.namedChildren ?? []) {
        const method = definitionFor(member);
        const methodName = method ? nameFor(method.declaration) : undefined;
        if (method && methodName && method.declaration.type !== 'class_definition') {
          candidates.push({ ...method, kind: 'method', parents: [name], scope: definition.declaration });
        }
      }
      continue;
    }
    candidates.push({ ...definition, kind: 'function', parents: [] });
  }
  return candidates;
};

const topLevelBindings = (root: Parser.SyntaxNode): ReadonlySet<string> => {
  const bindings = new Set<string>();
  for (const child of root.namedChildren) {
    const definition = definitionFor(child);
    const name = definition ? nameFor(definition.declaration) : undefined;
    if (name) bindings.add(name);
    const assignment = child.type === 'assignment'
      ? child
      : child.type === 'expression_statement'
        ? child.namedChildren.find((item) => item.type === 'assignment')
        : undefined;
    if (assignment) {
      const left = assignment.childForFieldName('left');
      if (left?.type === 'identifier') bindings.add(left.text);
    }
  }
  return bindings;
};

const bindingFor = (node: Parser.SyntaxNode, moduleSpecifier: string, fromImport: boolean): ImportBinding | undefined => {
  const imported = node.type === 'aliased_import' ? node.childForFieldName('name') : node;
  if (!imported) return undefined;
  const alias = node.type === 'aliased_import' ? node.childForFieldName('alias')?.text : undefined;
  const segments = imported.text.split('.');
  const fallback = fromImport ? segments.at(-1) : segments[0];
  return fallback ? { moduleSpecifier, bindingName: alias ?? fallback, partial: false } : undefined;
};

const importBindingsFor = (node: Parser.SyntaxNode): readonly ImportBinding[] => {
  if (node.type === 'import_statement') {
    return node.childrenForFieldName('name').flatMap((item) => {
      const binding = bindingFor(item, item.type === 'aliased_import' ? item.childForFieldName('name')?.text ?? item.text : item.text, false);
      return binding ? [binding] : [];
    });
  }
  const moduleSpecifier = node.childForFieldName('module_name')?.text;
  if (!moduleSpecifier) return [];
  const bindings = node.childrenForFieldName('name').flatMap((item) => {
    const binding = bindingFor(item, moduleSpecifier, true);
    return binding ? [binding] : [];
  });
  return bindings.length > 0 ? bindings : [{ moduleSpecifier, partial: true }];
};

const importsFor = (source: StructuredSource, root: Parser.SyntaxNode): readonly StructuredImport[] => {
  const bindings = topLevelBindings(root);
  const occurrences = new Map<string, number>();
  return root.namedChildren.flatMap((node) => {
    if (node.type !== 'import_statement' && node.type !== 'import_from_statement') return [];
    return importBindingsFor(node).map((binding) => {
      const key = `${binding.moduleSpecifier}\u0000${binding.bindingName ?? '*'}`;
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const completeness = binding.partial || (binding.bindingName !== undefined && bindings.has(binding.bindingName)) ? 'partial' : 'complete';
      return {
        id: createSymbolId({ filePath: source.filePath, qualifiedName: binding.bindingName ?? '*', kind: 'import', signatureDiscriminator: binding.moduleSpecifier, occurrence }),
        moduleSpecifier: binding.moduleSpecifier,
        bindingName: binding.bindingName,
        startByte: node.startIndex,
        endByte: node.endIndex,
        sourceHash: sha256Hex(source.bytes.subarray(node.startIndex, node.endIndex)),
        completeness,
        position: positionFor(node),
      };
    });
  });
};

const generationFor = (source: StructuredSource, diagnostics: readonly string[]): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: 'python',
  parserVersion: '0.25.0',
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics,
});

export class PythonStructuredParser implements StructuredLanguageParser {
  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    const text = decodeUtf8(source.bytes);
    const parser = new Parser();
    parser.setLanguage(Python);
    const tree = parser.parse(text);
    const root = tree.rootNode;
    const diagnostics = diagnosticsFor(root);
    const occurrences = new Map<string, number>();
    const drafts = candidatesFor(root).flatMap((candidate) => {
      if (hasSyntaxProblem(candidate.declaration) || hasSyntaxProblem(candidate.range) || (candidate.scope && hasSyntaxProblem(candidate.scope))) return [];
      const name = nameFor(candidate.declaration);
      if (!name) return [];
      const qualifiedName = [...candidate.parents, name].join('.');
      const signatureDiscriminator = signatureFor(source.bytes, candidate.declaration);
      const occurrenceKey = `${qualifiedName}\u0000${candidate.kind}\u0000${signatureDiscriminator}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      const declaration: StructuredDeclaration = {
        symbolId: createSymbolId({ filePath: source.filePath, qualifiedName, kind: candidate.kind, signatureDiscriminator, occurrence }), qualifiedName, kind: candidate.kind, signatureDiscriminator, position: positionFor(candidate.range), name,
        startByte: candidate.range.startIndex, endByte: candidate.declaration.endIndex, sourceHash: sha256Hex(source.bytes.subarray(candidate.range.startIndex, candidate.declaration.endIndex)), languageId: source.language, isExact: true,
        rawSource: rawSourceFor(source.bytes, candidate.range.startIndex, candidate.declaration.endIndex),
      };
      return [{ declaration, nodeId: candidate.declaration.id, scopeId: candidate.scope?.id }];
    }).sort((left, right) => left.declaration.startByte - right.declaration.startByte);
    const classSymbols = new Map(drafts.filter(({ declaration }) => declaration.kind === 'class').map(({ declaration, nodeId }) => [nodeId, declaration.symbolId]));
    const connected = drafts.map(({ declaration, scopeId }) => {
      const parentSymbolId = scopeId === undefined ? undefined : classSymbols.get(scopeId);
      return parentSymbolId ? { ...declaration, parentSymbolId } : declaration;
    });
    const imports = importsFor(source, root);
    const generation = generationFor(source, diagnostics);
    return diagnostics.length === 0
      ? { status: 'ok', retrievability: 'exact', declarations: connected, imports, generation }
      : { status: 'degraded', retrievability: 'partial', declarations: connected, imports, generation, failure: { reasonCode: 'parse_error', message: 'Python parse diagnostics were reported.' } };
  }
}

const fallbackEnd = (lines: readonly string[], start: number, indent: number): number => {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() && line.search(/\S/u) <= indent) return index - 1;
  }
  return lines.length - 1;
};

const fixedLineFallback = (file: FileToChunk): ParsedSourceFile => {
  const lines = file.content.split('\n');
  const declarations: ParsedDeclaration[] = [];
  const imports = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^(?:from|import)\s/u.test(line));
  if (imports.length > 0) {
    const first = imports[0];
    const last = imports.at(-1);
    if (first && last) declarations.push({ type: 'import', name: 'imports', startLine: first.index + 1, endLine: last.index + 1, content: lines.slice(first.index, last.index + 1).join('\n').trim() });
  }
  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)(?:async\s+)?(class|def)\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(line);
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    const name = match[3];
    if (!name || (indent > 0 && match[2] === 'class')) continue;
    const end = fallbackEnd(lines, index, indent);
    const type: SymbolKind = match[2] === 'class' ? 'class' : indent === 0 ? 'function' : 'method';
    declarations.push({ type, name, startLine: index + 1, endLine: end + 1, content: lines.slice(index, end + 1).join('\n').trim() });
  }
  return { rootType: 'module', declarations: declarations.sort((left, right) => left.startLine - right.startLine) };
};

export class PythonLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'python';
  readonly fileExtensions = ['.py'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    return new PythonStructuredParser();
  }

  async createParser(): Promise<{ parse(file: FileToChunk): Promise<ParsedSourceFile> }> {
    const structured = await this.createStructuredParser();
    return {
      parse: async (file) => {
        const bytes = textEncoder.encode(file.content);
        try {
          const result = await structured.parseStructured({ filePath: file.filePath, language: file.language, bytes, text: file.content });
          const declarations = result.declarations.map(({ kind, name, position, rawSource }): ParsedDeclaration => ({ type: kind, name, startLine: position.startLine, endLine: position.endLine, content: rawSource ?? '' }));
          const importNodes = new Map(result.imports.map((item) => [`${item.startByte}:${item.endByte}`, item]));
          const ranges = [...importNodes.values()].sort((left, right) => left.startByte - right.startByte);
          if (ranges.length > 0) {
            const first = ranges[0];
            const last = ranges.at(-1);
            if (first && last) declarations.push({ type: 'import', name: 'imports', startLine: first.position.startLine, endLine: last.position.endLine, content: decodeUtf8(bytes.subarray(first.startByte, last.endByte)) });
          }
          return { rootType: 'module', declarations: declarations.sort((left, right) => left.startLine - right.startLine) };
        } catch (error) {
          if (error instanceof Error) return fixedLineFallback(file);
          throw error;
        }
      },
    };
  }
}
