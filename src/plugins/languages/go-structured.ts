import type Parser from 'tree-sitter';
import type Go from 'tree-sitter-go';

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
import type { SymbolKind } from '../../types/index.js';

export interface GoTreeSitterRuntime {
  readonly Parser: typeof Parser;
  readonly Go: typeof Go;
}

type DeclarationDescriptor = {
  readonly node: Parser.SyntaxNode;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly ownerTypeName?: string;
};

const isExportedName = (name: string): boolean => {
  const first = name[0];
  return first !== undefined && first === first.toUpperCase();
};
const isDocCommentLine = (line: string): boolean => /^\/\//.test(line.trim());
const isGoDirectiveLine = (line: string): boolean => /^\/\/go:/.test(line.trim());

const findDeclarationStartByte = (
  source: StructuredSource,
  textLines: readonly string[],
  startLine: number,
  offsets: Utf8OffsetTable,
): number => {
  let lineIndex = startLine - 1;

  while (lineIndex > 0) {
    const previousLine = textLines[lineIndex - 1];
    if (previousLine === undefined) break;
    const trimmed = previousLine.trim();
    if (trimmed === '') {
      break;
    }
    if (isDocCommentLine(previousLine) || isGoDirectiveLine(previousLine)) {
      lineIndex -= 1;
      continue;
    }
    break;
  }

  const charOffset = textLines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0);
  return offsets.byteOffsetAtUtf16(charOffset);
};

const typeSpecsFor = (node: Parser.SyntaxNode): readonly Parser.SyntaxNode[] => {
  if (node.type !== 'type_declaration') return [];
  return node.children.filter((child) => child.type === 'type_spec' || child.type === 'type_alias');
};

const importSpecsFor = (node: Parser.SyntaxNode): readonly Parser.SyntaxNode[] => {
  if (node.type !== 'import_declaration') return [];
  const specList = node.children.find((child) => child.type === 'import_spec_list');
  if (specList) return specList.children.filter((child) => child.type === 'import_spec');
  return node.children.filter((child) => child.type === 'import_spec');
};

const nameForTypeSpec = (spec: Parser.SyntaxNode): string | undefined => {
  const nameNode = spec.children.find((child) => child.type === 'type_identifier');
  return nameNode?.text;
};

const kindForTypeSpec = (spec: Parser.SyntaxNode): SymbolKind => {
  const typeNode = spec.children.find(
    (child) =>
      child.type === 'interface_type' ||
      child.type === 'struct_type' ||
      child.type === 'slice_type' ||
      child.type === 'array_type' ||
      child.type === 'pointer_type',
  );
  if (typeNode?.type === 'interface_type') return 'interface';
  return 'class';
};

const nameForFunction = (node: Parser.SyntaxNode): string | undefined => {
  const nameNode = node.children.find((child) => child.type === 'identifier');
  return nameNode?.text;
};

const nameForMethodInExpressionStatement = (node: Parser.SyntaxNode): string | undefined => {
  if (node.type !== 'expression_statement') return undefined;
  const typeConv = node.children.find((child) => child.type === 'type_conversion_expression');
  if (!typeConv) return undefined;
  const funcType = typeConv.children.find((child) => child.type === 'function_type');
  if (!funcType) return undefined;
  const methodName = funcType.children.find((child) => child.type === 'generic_type')?.children.find((child) => child.type === 'type_identifier');
  return methodName?.text;
};

const receiverTypeNameForExpressionStatement = (node: Parser.SyntaxNode): string | undefined => {
  if (node.type !== 'expression_statement') return undefined;
  const typeConv = node.children.find((child) => child.type === 'type_conversion_expression');
  if (!typeConv) return undefined;
  const funcType = typeConv.children.find((child) => child.type === 'function_type');
  if (!funcType) return undefined;
  const receiverNode = funcType.children.find((child) => child.type === 'parameter_list');
  if (!receiverNode) return undefined;
  const parameterDecl = receiverNode.children.find((child) => child.type === 'parameter_declaration');
  if (!parameterDecl) return undefined;
  const typeNode = parameterDecl.children.find((child) =>
    child.type === 'generic_type' || child.type === 'pointer_type' || child.type === 'type_identifier');
  if (!typeNode) return undefined;
  const genericType = typeNode.descendantsOfType('generic_type')[0];
  if (genericType) return genericType.children.find((child) => child.type === 'type_identifier')?.text;
  return typeNode.children.find((child) => child.type === 'type_identifier')?.text ?? typeNode.text;
};

const nameForMethod = (node: Parser.SyntaxNode): string | undefined => {
  const nameNode = node.children.find((child) => child.type === 'field_identifier');
  return nameNode?.text;
};

const receiverTypeNameFor = (node: Parser.SyntaxNode): string | undefined => {
  const receiverNode = node.children.find((child) => child.type === 'parameter_list');
  if (!receiverNode) return undefined;
  const genericTypeNode = receiverNode.descendantsOfType('generic_type')[0];
  if (genericTypeNode) {
    const nameNode = genericTypeNode.children.find((child) => child.type === 'type_identifier');
    return nameNode?.text;
  }
  const typeNode = receiverNode.descendantsOfType('type_identifier')[0];
  return typeNode?.text;
};

const hasSyntaxProblem = (node: Parser.SyntaxNode): boolean =>
  node.isError || node.isMissing || node.children.some(hasSyntaxProblem);

const diagnosticsFor = (node: Parser.SyntaxNode): readonly string[] => {
  const diagnostics: string[] = [];
  const visit = (current: Parser.SyntaxNode): void => {
    if (current.isError || current.isMissing) {
      diagnostics.push(`${current.type} at ${current.startPosition.row + 1}:${current.startPosition.column}`);
    }
    for (const child of current.children) visit(child);
  };
  visit(node);
  return diagnostics;
};

const positionFor = (node: Parser.SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  startColumn: node.startPosition.column,
  endLine: node.endPosition.row + 1,
  endColumn: node.endPosition.column,
});

const signatureFor = (source: StructuredSource, node: Parser.SyntaxNode): string => {
  const body = node.children.find((child) => child.type === 'block');
  const endUtf16Index = body?.startIndex ?? node.endIndex;
  return source.text.slice(node.startIndex, endUtf16Index).replace(/\s+/gu, ' ').trim();
};

const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const descriptors: DeclarationDescriptor[] = [];
  const typeInterfaces = new Map<string, Parser.SyntaxNode>();

  for (const child of root.namedChildren) {
    for (const spec of typeSpecsFor(child)) {
      const name = nameForTypeSpec(spec);
      if (!name) continue;
      typeInterfaces.set(name, spec);
    }
  }

  for (const child of root.namedChildren) {
    for (const spec of typeSpecsFor(child)) {
      if (spec.type === 'type_alias') continue;
      const name = nameForTypeSpec(spec);
      if (name) {
        descriptors.push({ node: spec, kind: kindForTypeSpec(spec), name, qualifiedName: name });
      }
    }

    if (child.type === 'function_declaration') {
      const name = nameForFunction(child);
      if (!name) continue;
      if (!isExportedName(name)) continue;
      descriptors.push({ node: child, kind: 'function', name, qualifiedName: name });
      continue;
    }

    if (child.type === 'method_declaration') {
      const name = nameForMethod(child);
      const receiverType = receiverTypeNameFor(child);
      if (name && receiverType) {
        descriptors.push({
          node: child,
          kind: 'method',
          name,
          qualifiedName: `${receiverType}.${name}`,
          ownerTypeName: receiverType,
        });
      }
      continue;
    }

    const name = nameForMethodInExpressionStatement(child);
    const receiverType = receiverTypeNameForExpressionStatement(child);
    if (name && receiverType) {
      descriptors.push({
        node: child,
        kind: 'method',
        name,
        qualifiedName: `${receiverType}.${name}`,
        ownerTypeName: receiverType,
      });
    }
  }

  for (const [typeName, specNode] of typeInterfaces) {
    const interfaceType = specNode.children.find((c) => c.type === 'interface_type');
    if (!interfaceType) continue;
    for (const methodSpec of interfaceType.namedChildren) {
      if (methodSpec.type !== 'method_elem') continue;
      const methodName = methodSpec.children.find((c) => c.type === 'field_identifier')?.text;
      if (!methodName) continue;
      descriptors.push({
        node: methodSpec,
        kind: 'method',
        name: methodName,
        qualifiedName: `${typeName}.${methodName}`,
        ownerTypeName: typeName,
      });
    }
  }

  return descriptors;
};

const importBindingsFor = (node: Parser.SyntaxNode): readonly { moduleSpecifier: string; bindingName?: string }[] => {
  const result: { moduleSpecifier: string; bindingName?: string }[] = [];
  for (const importSpec of importSpecsFor(node)) {
    const pathNode = importSpec.childForFieldName('path');
    const nameNode = importSpec.childForFieldName('name');
    const moduleSpecifier = pathNode?.text ?? '';
    const bindingName = nameNode?.text;
    result.push({ moduleSpecifier, bindingName });
  }
  return result;
};

const importsFor = (source: StructuredSource, root: Parser.SyntaxNode, offsets: Utf8OffsetTable): readonly StructuredImport[] => {
  const imports: StructuredImport[] = [];
  const occurrences = new Map<string, number>();

  for (const node of root.namedChildren) {
    if (node.type !== 'import_declaration' || hasSyntaxProblem(node)) continue;
    const startByte = offsets.byteOffsetAtUtf16(node.startIndex);
    const endByte = offsets.byteOffsetAtUtf16(node.endIndex);

    for (const binding of importBindingsFor(node)) {
      const key = `${binding.moduleSpecifier}\u0000${binding.bindingName ?? '*'}`;
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      imports.push({
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
        completeness: 'complete',
        position: positionFor(node),
      });
    }
  }

  return imports;
};

const generationFor = (source: StructuredSource, diagnostics: readonly string[]): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: 'go',
  parserVersion: '0.25.0',
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics,
});

export class GoStructuredParser implements StructuredLanguageParser {
  constructor(private readonly runtime: GoTreeSitterRuntime) {}

  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    if (!source.bytes) {
      return {
        status: 'degraded',
        retrievability: 'partial',
        declarations: [],
        imports: [],
        failure: { reasonCode: 'invariant_violation', message: 'Go structured parsing requires original source bytes.' },
      };
    }

    const parser = new this.runtime.Parser();
    parser.setLanguage(this.runtime.Go);
    const root = parser.parse(source.text).rootNode;
    const diagnostics = diagnosticsFor(root);
    const offsets = createUtf8OffsetTable(source.text);
    const textLines = source.text.split('\n');

    const occurrences = new Map<string, number>();
    const typeByName = new Map<string, string>();

    const drafts = declarationsFor(root)
      .filter((descriptor) => !hasSyntaxProblem(descriptor.node))
      .map((descriptor) => {
        const signatureDiscriminator = signatureFor(source, descriptor.node);
        const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
        const occurrence = occurrences.get(occurrenceKey) ?? 0;
        occurrences.set(occurrenceKey, occurrence + 1);

        const endByte = offsets.byteOffsetAtUtf16(descriptor.node.endIndex);
        const startByte = findDeclarationStartByte(source, textLines, descriptor.node.startPosition.row + 1, offsets);
        const declaration: StructuredDeclaration = {
          symbolId: createSymbolId({
            filePath: source.filePath,
            qualifiedName: descriptor.qualifiedName,
            kind: descriptor.kind,
            signatureDiscriminator,
            occurrence,
          }),
          qualifiedName: descriptor.qualifiedName,
          kind: descriptor.kind,
          signatureDiscriminator,
          position: positionFor(descriptor.node),
          name: descriptor.name,
          startByte,
          endByte,
          sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
          languageId: source.language,
          isExact: true,
          rawSource: decodeUtf8(source.bytes.subarray(startByte, endByte)),
        };

        if (descriptor.kind === 'class' || descriptor.kind === 'interface') {
          typeByName.set(descriptor.name, declaration.symbolId);
        }

        return { declaration, ownerTypeName: descriptor.ownerTypeName };
      })
      .sort((left, right) => left.declaration.startByte - right.declaration.startByte);

    const declarations = drafts.map(({ declaration, ownerTypeName }) => {
      if (!ownerTypeName) return declaration;
      const parentSymbolId = typeByName.get(ownerTypeName);
      return parentSymbolId ? { ...declaration, parentSymbolId } : declaration;
    });

    const imports = importsFor(source, root, offsets);
    const generation = generationFor(source, diagnostics);

    if (diagnostics.length === 0) {
      return { status: 'ok', retrievability: 'exact', declarations, imports, generation };
    }

    return {
      status: 'degraded',
      retrievability: 'partial',
      declarations,
      imports,
      generation,
      failure: { reasonCode: 'parse_error', message: 'Go parse diagnostics were reported.' },
    };
  }
}
