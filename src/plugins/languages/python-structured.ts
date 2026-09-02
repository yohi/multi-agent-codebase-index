import type Parser from 'tree-sitter';
import type Python from 'tree-sitter-python';

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
import { createUtf8OffsetTable } from '../../structured/utf8-offsets.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';

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

type ImportBinding = { readonly moduleSpecifier: string; readonly bindingName?: string; readonly partial: boolean };

const moduleControlFlowStatements = new Set(['for_statement', 'if_statement', 'try_statement', 'while_statement', 'with_statement']);

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

const bindingNamesFor = (node: Parser.SyntaxNode): readonly string[] => {
  if (node.type === 'identifier') return [node.text];
  if (node.type !== 'pattern_list' && node.type !== 'list_pattern' && node.type !== 'tuple_pattern') return [];
  return node.namedChildren.flatMap(bindingNamesFor);
};

const bindingTargetFor = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined => {
  if (node.type === 'assignment' || node.type === 'for_statement') return node.childForFieldName('left') ?? undefined;
  if (node.type !== 'expression_statement') return undefined;
  return node.namedChildren.find((child) => child.type === 'assignment')?.childForFieldName('left') ?? undefined;
};

const bindingNamesInNestedBlocks = (node: Parser.SyntaxNode): readonly string[] => {
  const definition = definitionFor(node);
  if (definition) return [];
  if (node.type === 'block') return node.namedChildren.flatMap(bindingNamesInStatement);
  return node.namedChildren.flatMap(bindingNamesInNestedBlocks);
};

const bindingNamesInStatement = (node: Parser.SyntaxNode): readonly string[] => {
  const definition = definitionFor(node);
  if (definition) {
    const name = nameFor(definition.declaration);
    return name ? [name] : [];
  }
  const target = bindingTargetFor(node);
  const bindings = target ? [...bindingNamesFor(target)] : [];
  if (!moduleControlFlowStatements.has(node.type)) return bindings;
  return [...bindings, ...node.namedChildren.flatMap(bindingNamesInNestedBlocks)];
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

const completenessFor = (
  binding: ImportBinding,
  bindingsBefore: ReadonlySet<string>,
): 'complete' | 'partial' => {
  if (binding.partial) return 'partial';
  if (binding.bindingName !== undefined && bindingsBefore.has(binding.bindingName)) return 'partial';
  return 'complete';
};

type ImportCollectionContext = {
  readonly source: StructuredSource;
  readonly offsets: Utf8OffsetTable;
  readonly problemNodeIds: ReadonlySet<number>;
  readonly bindingsBefore: Set<string>;
  readonly occurrences: Map<string, number>;
};

const importsForNode = (
  node: Parser.SyntaxNode,
  context: ImportCollectionContext,
): readonly StructuredImport[] => {
  if ((node.type !== 'import_statement' && node.type !== 'import_from_statement') || context.problemNodeIds.has(node.id)) {
    return [];
  }
  const { source, offsets, bindingsBefore, occurrences } = context;
  const { startByte, endByte } = byteRangeFor(offsets, node);
  return importBindingsFor(node).map((binding) => {
    const key = `${binding.moduleSpecifier}\u0000${binding.bindingName ?? '*'}`;
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const completeness = completenessFor(binding, bindingsBefore);
    const imported: StructuredImport = {
      id: createSymbolId({
        filePath: source.filePath,
        qualifiedName: binding.bindingName ?? '*',
        kind: 'import',
        signatureDiscriminator: binding.moduleSpecifier,
        occurrence,
      }),
      moduleSpecifier: binding.moduleSpecifier,
      bindingName: binding.bindingName,
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      completeness,
      position: positionFor(node),
    };
    if (binding.bindingName) bindingsBefore.add(binding.bindingName);
    return imported;
  });
};

type ImportCollectionInput = {
  readonly source: StructuredSource;
  readonly root: Parser.SyntaxNode;
  readonly offsets: Utf8OffsetTable;
  readonly problemNodeIds: ReadonlySet<number>;
};

const importsFor = ({ source, root, offsets, problemNodeIds }: ImportCollectionInput): readonly StructuredImport[] => {
  const bindingsBefore = new Set<string>();
  const occurrences = new Map<string, number>();
  const imports: StructuredImport[] = [];
  const context: ImportCollectionContext = { source, offsets, problemNodeIds, bindingsBefore, occurrences };

  for (const node of root.namedChildren) {
    imports.push(...importsForNode(node, context));
    for (const binding of bindingNamesInStatement(node)) bindingsBefore.add(binding);
  }
  return imports;
};

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
    const offsets = createUtf8OffsetTable(source.text);
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
