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

const attachedDecorators = (node: ts.Node): readonly ts.Decorator[] =>
  ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];

const isAdjacent = (sourceFile: ts.SourceFile, from: number, to: number): boolean => {
  if (sourceFile.text.slice(from, to).trim() !== '') return false;
  const fromLine = sourceFile.getLineAndCharacterOfPosition(from).line;
  const toLine = sourceFile.getLineAndCharacterOfPosition(to).line;
  return toLine - fromLine <= 1;
};

export const declarationStart = (sourceFile: ts.SourceFile, node: ts.Node): number => {
  const decorators = attachedDecorators(node);
  const firstDecorator = decorators.reduce(
    (earliest, decorator) => Math.min(earliest, decorator.getStart(sourceFile)),
    node.getStart(sourceFile),
  );
  const comments = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
  let earliest = firstDecorator;

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (comment === undefined) continue;
    const commentText = sourceFile.text.slice(comment.pos, comment.end);
    if (!commentText.startsWith('/**') || !isAdjacent(sourceFile, comment.end, earliest)) break;
    earliest = comment.pos;
  }

  return earliest;
};

const signatureStart = (sourceFile: ts.SourceFile, node: ts.Node): number => {
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
    return node.parent.getStart(sourceFile);
  }

  const excluded = [
    ...attachedDecorators(node),
    ...(ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []),
  ];
  if (excluded.length === 0) return node.getStart(sourceFile);
  return excluded.reduce((latest, item) => Math.max(latest, item.end), node.getStart(sourceFile));
};

const memberBodyStart = (
  sourceFile: ts.SourceFile,
  node: ts.ClassDeclaration | ts.ClassExpression | ts.InterfaceDeclaration | ts.EnumDeclaration,
): number | undefined => {
  const start = node.getStart(sourceFile);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    sourceFile.text,
    undefined,
    start,
    Math.max(0, node.members.pos - start),
  );
  let openingBrace: number | undefined;

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.OpenBraceToken) openingBrace = scanner.getTokenStart();
  }

  return openingBrace;
};

const bodyStart = (sourceFile: ts.SourceFile, node: ts.Node): number | undefined => {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node)
  ) {
    return node.body && ts.isBlock(node.body) ? node.body.getStart(sourceFile) : undefined;
  }
  if (
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return memberBodyStart(sourceFile, node);
  }
  if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
    return node.body.getStart(sourceFile);
  }
  return undefined;
};

const initializerEqualsStart = (sourceFile: ts.SourceFile, node: ts.Node): number | undefined => {
  if (
    (!ts.isVariableDeclaration(node) && !ts.isPropertyDeclaration(node)) ||
    node.initializer === undefined
  ) {
    return undefined;
  }
  return node
    .getChildren(sourceFile)
    .find((child) => child.kind === ts.SyntaxKind.EqualsToken)
    ?.getStart(sourceFile);
};

export const signatureFor = (
  sourceFile: ts.SourceFile,
  descriptor: DeclarationDescriptor,
): string => {
  const { signatureNode: node } = descriptor;
  const start = signatureStart(sourceFile, node);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    sourceFile.text,
    undefined,
    start,
    Math.max(0, node.end - start),
  );
  const bodyOpen = bodyStart(sourceFile, node);
  const initializerEquals = initializerEqualsStart(sourceFile, node);
  const tokens = descriptor.signaturePrefix === undefined ? [] : [descriptor.signaturePrefix];
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const atTopLevel = parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0;
    if (token === ts.SyntaxKind.SemicolonToken && atTopLevel) break;
    if (token === ts.SyntaxKind.EqualsToken && scanner.getTokenStart() === initializerEquals) break;
    if (token === ts.SyntaxKind.OpenBraceToken && atTopLevel && scanner.getTokenStart() === bodyOpen) break;

    const tokenText = scanner.getTokenText();
    tokens.push(
      token === ts.SyntaxKind.Identifier || token === ts.SyntaxKind.PrivateIdentifier
        ? tokenText.normalize('NFC')
        : tokenText,
    );

    if (token === ts.SyntaxKind.OpenParenToken) parenthesisDepth += 1;
    else if (token === ts.SyntaxKind.CloseParenToken && parenthesisDepth > 0) parenthesisDepth -= 1;
    else if (token === ts.SyntaxKind.OpenBracketToken) bracketDepth += 1;
    else if (token === ts.SyntaxKind.CloseBracketToken && bracketDepth > 0) bracketDepth -= 1;
    else if (token === ts.SyntaxKind.OpenBraceToken) braceDepth += 1;
    else if (token === ts.SyntaxKind.CloseBraceToken && braceDepth > 0) braceDepth -= 1;

    if (token === ts.SyntaxKind.EqualsGreaterThanToken && atTopLevel && ts.isArrowFunction(node)) break;
  }

  return tokens.join(' ');
};

const variableDescriptor = (node: ts.VariableDeclaration): DeclarationDescriptor | undefined => {
  if (!ts.isIdentifier(node.name) || !ts.isVariableDeclarationList(node.parent) || node.parent.declarations.length !== 1) {
    return undefined;
  }

  const rangeStartNode = ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node.parent;
  const kind: SymbolKind =
    node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ? 'function'
      : (node.parent.flags & ts.NodeFlags.Const) !== 0
        ? 'constant'
        : 'variable';
  return {
    name: normalizedIdentifier(node.name),
    kind,
    createsScope: false,
    rangeStartNode,
    signatureNode: node,
  };
};

export const describeDeclaration = (node: ts.Node): DeclarationDescriptor | undefined => {
  if (ts.isConstructorDeclaration(node)) {
    return { name: 'constructor', kind: 'constructor', createsScope: false, rangeStartNode: node, signatureNode: node };
  }
  if (ts.isClassDeclaration(node)) {
    const name = hasDefaultModifier(node) ? 'default' : node.name ? normalizedIdentifier(node.name) : undefined;
    return name ? { name, kind: 'class', createsScope: true, rangeStartNode: node, signatureNode: node } : undefined;
  }
  if (ts.isFunctionDeclaration(node)) {
    const name = hasDefaultModifier(node) ? 'default' : node.name ? normalizedIdentifier(node.name) : undefined;
    return name ? { name, kind: 'function', createsScope: false, rangeStartNode: node, signatureNode: node } : undefined;
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { name: normalizedIdentifier(node.name), kind: 'interface', createsScope: false, rangeStartNode: node, signatureNode: node };
  }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return ts.isIdentifier(node.name)
      ? { name: normalizedIdentifier(node.name), kind: 'method', createsScope: false, rangeStartNode: node, signatureNode: node }
      : undefined;
  }
  if (ts.isEnumDeclaration(node)) {
    return { name: normalizedIdentifier(node.name), kind: 'enum', createsScope: false, rangeStartNode: node, signatureNode: node };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return { name: normalizedIdentifier(node.name), kind: 'typeAlias', createsScope: false, rangeStartNode: node, signatureNode: node };
  }
  if (ts.isPropertyDeclaration(node)) {
    return ts.isIdentifier(node.name)
      ? { name: normalizedIdentifier(node.name), kind: 'property', createsScope: false, rangeStartNode: node, signatureNode: node }
      : undefined;
  }
  if (ts.isModuleDeclaration(node)) {
    return { name: node.name.text.normalize('NFC'), kind: 'namespace', createsScope: true, rangeStartNode: node, signatureNode: node };
  }
  if (ts.isVariableDeclaration(node)) return variableDescriptor(node);
  if (ts.isExportAssignment(node) && !node.isExportEquals) {
    const expression = node.expression;
    const kind: SymbolKind | undefined =
      ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
        ? 'function'
        : ts.isClassExpression(expression)
          ? 'class'
          : undefined;
    return kind
      ? {
          name: 'default',
          kind,
          createsScope: kind === 'class',
          rangeStartNode: node,
          signatureNode: expression,
          signaturePrefix: 'default',
        }
      : undefined;
  }
  return undefined;
};
