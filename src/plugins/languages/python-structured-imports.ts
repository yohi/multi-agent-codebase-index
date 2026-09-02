import type Parser from 'tree-sitter';

import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';

type ImportBinding = { readonly moduleSpecifier: string; readonly bindingName?: string; readonly partial: boolean };

const moduleControlFlowStatements = new Set(['for_statement', 'if_statement', 'try_statement', 'while_statement', 'with_statement']);

const isDeclaration = (node: Parser.SyntaxNode): boolean =>
  node.type === 'class_definition' || node.type === 'function_definition' || node.type === 'async_function_definition';

const definitionFor = (node: Parser.SyntaxNode): Parser.SyntaxNode | undefined => {
  if (isDeclaration(node)) return node;
  if (node.type !== 'decorated_definition') return undefined;
  const definition = node.childForFieldName('definition');
  return definition && isDeclaration(definition) ? definition : undefined;
};

const positionFor = (node: Parser.SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});

const byteRangeFor = (offsets: Utf8OffsetTable, node: Parser.SyntaxNode) => ({
  startByte: offsets.byteOffsetAtUtf16(node.startIndex),
  endByte: offsets.byteOffsetAtUtf16(node.endIndex),
});

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
  if (definitionFor(node)) return [];
  if (node.type === 'block') return node.namedChildren.flatMap(bindingNamesInStatement);
  return node.namedChildren.flatMap(bindingNamesInNestedBlocks);
};

const bindingNamesInStatement = (node: Parser.SyntaxNode): readonly string[] => {
  const definition = definitionFor(node);
  if (definition) {
    const name = definition.childForFieldName('name')?.text;
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

export const importsFor = ({ source, root, offsets, problemNodeIds }: ImportCollectionInput): readonly StructuredImport[] => {
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
