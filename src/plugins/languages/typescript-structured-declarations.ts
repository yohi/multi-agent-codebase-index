import ts from 'typescript';
import type { SymbolKind } from '../../types/index.js';

export interface DeclarationDescriptor {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly createsScope: boolean;
  readonly rangeStartNode: ts.Node;
  readonly signatureNode: ts.Node;
  readonly signaturePrefix?: string;
}

const normalizedIdentifier = (identifier: ts.Identifier): string => identifier.text.normalize('NFC');

const hasDefaultModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);

const declarationNameFor = (node: ts.ClassDeclaration | ts.FunctionDeclaration): string | undefined => {
  if (hasDefaultModifier(node)) return 'default';
  return node.name ? normalizedIdentifier(node.name) : undefined;
};

const variableDescriptor = (node: ts.VariableDeclaration): DeclarationDescriptor | undefined => {
  if (!ts.isIdentifier(node.name) || !ts.isVariableDeclarationList(node.parent) || node.parent.declarations.length !== 1) {
    return undefined;
  }

  const rangeStartNode = ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node.parent;
  let kind: SymbolKind;
  if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    kind = 'function';
  } else if (Boolean(node.parent.flags & ts.NodeFlags.Constant)) {
    kind = 'constant';
  } else {
    kind = 'variable';
  }
  return {
    name: normalizedIdentifier(node.name),
    kind,
    createsScope: false,
    rangeStartNode,
    signatureNode: node,
  };
};

const constructorDescriptor = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (!ts.isConstructorDeclaration(node)) return undefined;
  return { name: 'constructor', kind: 'constructor', createsScope: false, rangeStartNode: node, signatureNode: node };
};

const classDescriptor = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (!ts.isClassDeclaration(node)) return undefined;
  const name = declarationNameFor(node);
  if (!name) return undefined;
  return { name, kind: 'class', createsScope: true, rangeStartNode: node, signatureNode: node };
};

const functionDescriptor = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (!ts.isFunctionDeclaration(node)) return undefined;
  const name = declarationNameFor(node);
  if (!name) return undefined;
  return { name, kind: 'function', createsScope: false, rangeStartNode: node, signatureNode: node };
};

const interfaceDescriptor = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (!ts.isInterfaceDeclaration(node)) return undefined;
  return { name: normalizedIdentifier(node.name), kind: 'interface', createsScope: false, rangeStartNode: node, signatureNode: node };
};

const methodDescriptor = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (!ts.isMethodDeclaration(node) && !ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node)) {
    return undefined;
  }
  if (!ts.isIdentifier(node.name)) return undefined;
  return { name: normalizedIdentifier(node.name), kind: 'method', createsScope: false, rangeStartNode: node, signatureNode: node };
};

const enumDescriptor = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (!ts.isEnumDeclaration(node)) return undefined;
  return { name: normalizedIdentifier(node.name), kind: 'enum', createsScope: false, rangeStartNode: node, signatureNode: node };
};

const typeAliasDescriptor = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (!ts.isTypeAliasDeclaration(node)) return undefined;
  return { name: normalizedIdentifier(node.name), kind: 'typeAlias', createsScope: false, rangeStartNode: node, signatureNode: node };
};

const propertyDescriptor = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (!ts.isPropertyDeclaration(node) || !ts.isIdentifier(node.name)) return undefined;
  return { name: normalizedIdentifier(node.name), kind: 'property', createsScope: false, rangeStartNode: node, signatureNode: node };
};

const moduleDescriptor = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (!ts.isModuleDeclaration(node)) return undefined;
  return { name: node.name.text.normalize('NFC'), kind: 'namespace', createsScope: true, rangeStartNode: node, signatureNode: node };
};

const variableDeclarationDescriptor = (node: ts.Node): DeclarationDescriptor | undefined =>
  ts.isVariableDeclaration(node) ? variableDescriptor(node) : undefined;

const exportAssignmentKindFor = (node: ts.ExportAssignment): SymbolKind | undefined => {
  const expression = node.expression;
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return 'function';
  if (ts.isClassExpression(expression)) return 'class';
  return undefined;
};

const exportAssignmentDescriptor = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (!ts.isExportAssignment(node) || node.isExportEquals) return undefined;
  const kind = exportAssignmentKindFor(node);
  if (!kind) return undefined;
  const createsScope = kind === 'class';
  return {
    name: 'default',
    kind,
    createsScope,
    rangeStartNode: node,
    signatureNode: node.expression,
    signaturePrefix: 'default',
  };
};

type DeclarationDescriptorFactory = (node: ts.Node) => DeclarationDescriptor | undefined;

const declarationDescriptorFactories: readonly DeclarationDescriptorFactory[] = [
  constructorDescriptor,
  classDescriptor,
  functionDescriptor,
  interfaceDescriptor,
  methodDescriptor,
  enumDescriptor,
  typeAliasDescriptor,
  propertyDescriptor,
  moduleDescriptor,
  variableDeclarationDescriptor,
  exportAssignmentDescriptor,
];

export const describeDeclaration = (node: ts.Node): DeclarationDescriptor | undefined => {
  for (const factory of declarationDescriptorFactories) {
    const descriptor = factory(node);
    if (descriptor) return descriptor;
  }
  return undefined;
};
