import type Parser from 'tree-sitter';
import type Python from 'tree-sitter-python';

import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredLanguageParser,
  StructuredParseResult,
  StructuredSource,
} from '../../structured/contracts.js';
import { decodeUtf8, sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import {
  createUtf8OffsetTable,
  failedStructuredSource,
  Utf8SourceError,
} from '../../structured/utf8-offsets.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { importsFor } from './python-structured-imports.js';

export interface PythonTreeSitterRuntime {
  readonly Parser: typeof Parser;
  readonly Python: typeof Python;
}

type DeclarationCandidate = {
  readonly declaration: Parser.SyntaxNode;
  readonly range: Parser.SyntaxNode;
  readonly kind: 'class' | 'function' | 'method';
  readonly parents: readonly string[];
  readonly scope?: Parser.SyntaxNode;
};

const isDeclaration = (node: Parser.SyntaxNode): boolean =>
  node.type === 'class_definition' || node.type === 'function_definition' || node.type === 'async_function_definition';

const definitionFor = (node: Parser.SyntaxNode): { readonly declaration: Parser.SyntaxNode; readonly range: Parser.SyntaxNode } | undefined => {
  if (isDeclaration(node)) return { declaration: node, range: node };
  if (node.type !== 'decorated_definition') return undefined;
  const definition = node.childForFieldName('definition');
  return definition && isDeclaration(definition) ? { declaration: definition, range: node } : undefined;
};

const nameFor = (node: Parser.SyntaxNode): string | undefined => node.childForFieldName('name')?.text;

type SyntaxAnalysis = {
  readonly diagnostics: readonly string[];
  readonly problemNodeIds: ReadonlySet<number>;
};

const analyzeSyntax = (node: Parser.SyntaxNode): SyntaxAnalysis => {
  const diagnostics: string[] = [];
  const problemNodeIds = new Set<number>();
  const visit = (current: Parser.SyntaxNode): boolean => {
    let hasProblem = current.isError || current.isMissing;
    if (hasProblem) diagnostics.push(`${current.type} at ${current.startPosition.row + 1}:${current.startPosition.column}`);
    for (const child of current.children) {
      if (visit(child)) hasProblem = true;
    }
    if (hasProblem) problemNodeIds.add(current.id);
    return hasProblem;
  };
  visit(node);
  return { diagnostics, problemNodeIds };
};

const positionFor = (node: Parser.SyntaxNode) => ({ startLine: node.startPosition.row + 1, startColumn: node.startPosition.column, endLine: node.endPosition.row + 1, endColumn: node.endPosition.column });

const byteRangeFor = (offsets: Utf8OffsetTable, node: Parser.SyntaxNode) => ({
  startByte: offsets.byteOffsetAtUtf16(node.startIndex),
  endByte: offsets.byteOffsetAtUtf16(node.endIndex),
});

const rawSourceFor = (source: StructuredSource, startByte: number, endByte: number): string =>
  decodeUtf8(source.bytes.subarray(startByte, endByte));

const signatureFor = (source: StructuredSource, node: Parser.SyntaxNode): string => {
  const body = node.childForFieldName('body');
  return source.text.slice(node.startIndex, body?.startIndex ?? node.endIndex).replace(/\s+/gu, ' ').trim();
};

const methodCandidatesFor = (
  definition: Parser.SyntaxNode,
  className: string,
): readonly DeclarationCandidate[] => {
  const candidates: DeclarationCandidate[] = [];
  const block = definition.childForFieldName('body');
  for (const member of block?.namedChildren ?? []) {
    const method = definitionFor(member);
    if (!method) continue;
    const methodName = nameFor(method.declaration);
    if (!methodName || method.declaration.type === 'class_definition') continue;
    candidates.push({ ...method, kind: 'method', parents: [className], scope: definition });
  }
  return candidates;
};

const candidatesForChild = (child: Parser.SyntaxNode): readonly DeclarationCandidate[] => {
  const definition = definitionFor(child);
  if (!definition) return [];
  const name = nameFor(definition.declaration);
  if (!name) return [];
  if (definition.declaration.type === 'class_definition') {
    return [
      { ...definition, kind: 'class', parents: [] },
      ...methodCandidatesFor(definition.declaration, name),
    ];
  }
  return [{ ...definition, kind: 'function', parents: [] }];
};

const candidatesFor = (root: Parser.SyntaxNode): readonly DeclarationCandidate[] =>
  root.namedChildren.flatMap(candidatesForChild);

const generationFor = (source: StructuredSource, diagnostics: readonly string[]): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes), schemaVersion: 1, parserId: 'python', parserVersion: '0.25.0', fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial', fileDiagnostics: diagnostics,
});

export class PythonStructuredParser implements StructuredLanguageParser {
  constructor(private readonly runtime: PythonTreeSitterRuntime) {}

  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    if (!source.bytes) {
      return {
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [],
        failure: { reasonCode: 'invariant_violation', message: 'Python structured parsing requires original source bytes.' },
      };
    }
    const parser = new this.runtime.Parser();
    parser.setLanguage(this.runtime.Python);
    const root = parser.parse(source.text).rootNode;
    let offsets: ReturnType<typeof createUtf8OffsetTable>;
    try {
      offsets = createUtf8OffsetTable(source.text, source.bytes);
    } catch (error) {
      if (error instanceof Utf8SourceError) return failedStructuredSource(error);
      throw error;
    }
    const syntax = analyzeSyntax(root);
    const occurrences = new Map<string, number>();
    const drafts = candidatesFor(root).flatMap((candidate) => {
      if (syntax.problemNodeIds.has(candidate.declaration.id) || syntax.problemNodeIds.has(candidate.range.id) || (candidate.scope && syntax.problemNodeIds.has(candidate.scope.id))) return [];
      const name = nameFor(candidate.declaration);
      if (!name) return [];
      const qualifiedName = [...candidate.parents, name].join('.');
      const signatureDiscriminator = signatureFor(source, candidate.declaration);
      const occurrenceKey = `${qualifiedName}\u0000${candidate.kind}\u0000${signatureDiscriminator}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      const { startByte } = byteRangeFor(offsets, candidate.range);
      const declarationEndByte = offsets.byteOffsetAtUtf16(candidate.declaration.endIndex);
      const declaration: StructuredDeclaration = {
        symbolId: createSymbolId({ filePath: source.filePath, qualifiedName, kind: candidate.kind, signatureDiscriminator, occurrence }), qualifiedName, kind: candidate.kind, signatureDiscriminator,
        position: positionFor(candidate.range), name, startByte, endByte: declarationEndByte, sourceHash: sha256Hex(source.bytes.subarray(startByte, declarationEndByte)),
        languageId: source.language, isExact: true, rawSource: rawSourceFor(source, startByte, declarationEndByte),
      };
      return [{ declaration, nodeId: candidate.declaration.id, scopeId: candidate.scope?.id }];
    }).toSorted((left, right) => left.declaration.startByte - right.declaration.startByte);
    const classSymbols = new Map(drafts.filter(({ declaration }) => declaration.kind === 'class').map(({ declaration, nodeId }) => [nodeId, declaration.symbolId]));
    const declarations = drafts.map(({ declaration, scopeId }) => {
      const parentSymbolId = scopeId === undefined ? undefined : classSymbols.get(scopeId);
      return parentSymbolId ? { ...declaration, parentSymbolId } : declaration;
    });
    const imports = importsFor({ source, root, offsets, problemNodeIds: syntax.problemNodeIds });
    const generation = generationFor(source, syntax.diagnostics);
    return syntax.diagnostics.length === 0
      ? { status: 'ok', retrievability: 'exact', declarations, imports, generation }
      : { status: 'degraded', retrievability: 'partial', declarations, imports, generation, failure: { reasonCode: 'parse_error', message: 'Python parse diagnostics were reported.' } };
  }
}
