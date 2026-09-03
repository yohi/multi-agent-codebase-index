import type Parser from 'tree-sitter';

import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { hasSyntaxProblem, positionFor } from './go-structured-support.js';

const importSpecsFor = (node: Parser.SyntaxNode): readonly Parser.SyntaxNode[] => {
  if (node.type !== 'import_declaration') return [];
  const specList = node.children.find((child) => child.type === 'import_spec_list');
  if (specList) return specList.children.filter((child) => child.type === 'import_spec');
  return node.children.filter((child) => child.type === 'import_spec');
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

export const importsFor = (
  source: StructuredSource,
  root: Parser.SyntaxNode,
  offsets: Utf8OffsetTable,
): readonly StructuredImport[] => {
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
