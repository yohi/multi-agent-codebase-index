import type Parser from 'tree-sitter';

import type { SymbolKind } from '../../types/index.js';

export type DeclarationDescriptor = {
  readonly node: Parser.SyntaxNode;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly qualifiedName: string;
  readonly ownerTypeName?: string;
};

const isExportedName = (name: string): boolean => {
  const first = name.codePointAt(0);
  return first !== undefined && /^\p{Lu}$/u.test(String.fromCodePoint(first));
};

const typeSpecsFor = (node: Parser.SyntaxNode): readonly Parser.SyntaxNode[] => {
  if (node.type !== 'type_declaration') return [];
  return node.children.filter((child) => child.type === 'type_spec' || child.type === 'type_alias');
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

const typeInterfacesFor = (root: Parser.SyntaxNode): ReadonlyMap<string, Parser.SyntaxNode> => {
  const typeInterfaces = new Map<string, Parser.SyntaxNode>();
  for (const child of root.namedChildren) {
    for (const spec of typeSpecsFor(child)) {
      const name = nameForTypeSpec(spec);
      if (!name) continue;
      typeInterfaces.set(name, spec);
    }
  }
  return typeInterfaces;
};

const typeDescriptorsFor = (node: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const descriptors: DeclarationDescriptor[] = [];
  for (const spec of typeSpecsFor(node)) {
    if (spec.type === 'type_alias') continue;
    const name = nameForTypeSpec(spec);
    if (!name) continue;
    descriptors.push({ node: spec, kind: kindForTypeSpec(spec), name, qualifiedName: name });
  }
  return descriptors;
};

const functionDescriptorFor = (node: Parser.SyntaxNode): DeclarationDescriptor | undefined => {
  if (node.type !== 'function_declaration') return undefined;
  const name = nameForFunction(node);
  if (!name || !isExportedName(name)) return undefined;
  return { node, kind: 'function', name, qualifiedName: name };
};

const methodDescriptorFor = (node: Parser.SyntaxNode): DeclarationDescriptor | undefined => {
  if (node.type === 'method_declaration') {
    const name = nameForMethod(node);
    const receiverType = receiverTypeNameFor(node);
    if (!name || !receiverType) return undefined;
    return {
      node,
      kind: 'method',
      name,
      qualifiedName: `${receiverType}.${name}`,
      ownerTypeName: receiverType,
    };
  }
  if (node.type !== 'expression_statement') return undefined;
  const name = nameForMethodInExpressionStatement(node);
  const receiverType = receiverTypeNameForExpressionStatement(node);
  if (!name || !receiverType) return undefined;
  return {
    node,
    kind: 'method',
    name,
    qualifiedName: `${receiverType}.${name}`,
    ownerTypeName: receiverType,
  };
};

const descriptorsForChild = (child: Parser.SyntaxNode): readonly DeclarationDescriptor[] => {
  const typeDescriptors = typeDescriptorsFor(child);
  const functionDescriptor = functionDescriptorFor(child);
  if (functionDescriptor) return [...typeDescriptors, functionDescriptor];
  const methodDescriptor = methodDescriptorFor(child);
  return methodDescriptor ? [...typeDescriptors, methodDescriptor] : typeDescriptors;
};

const interfaceMethodDescriptorsFor = (
  typeInterfaces: ReadonlyMap<string, Parser.SyntaxNode>,
): readonly DeclarationDescriptor[] => {
  const descriptors: DeclarationDescriptor[] = [];
  for (const [typeName, specNode] of typeInterfaces) {
    const interfaceType = specNode.children.find((child) => child.type === 'interface_type');
    if (!interfaceType) continue;
    for (const methodSpec of interfaceType.namedChildren) {
      if (methodSpec.type !== 'method_elem') continue;
      const methodName = methodSpec.children.find((child) => child.type === 'field_identifier')?.text;
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

export const declarationsFor = (root: Parser.SyntaxNode): readonly DeclarationDescriptor[] => [
  ...root.namedChildren.flatMap(descriptorsForChild),
  ...interfaceMethodDescriptorsFor(typeInterfacesFor(root)),
];
