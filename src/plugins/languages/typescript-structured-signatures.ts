import ts from 'typescript';
import type { DeclarationDescriptor } from './typescript-structured-declarations.js';

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

type SignatureDepths = {
  readonly parenthesis: number;
  readonly bracket: number;
  readonly brace: number;
};

const isTopLevel = (depths: SignatureDepths): boolean =>
  depths.parenthesis === 0 && depths.bracket === 0 && depths.brace === 0;

type SignatureTokenContext = {
  readonly token: ts.SyntaxKind;
  readonly tokenStart: number;
  readonly atTopLevel: boolean;
  readonly bodyOpen: number | undefined;
  readonly initializerEquals: number | undefined;
};

const endsSignature = ({
  token,
  tokenStart,
  atTopLevel,
  bodyOpen,
  initializerEquals,
}: SignatureTokenContext): boolean => {
  if (token === ts.SyntaxKind.SemicolonToken && atTopLevel) return true;
  if (token === ts.SyntaxKind.EqualsToken && tokenStart === initializerEquals) return true;
  return token === ts.SyntaxKind.OpenBraceToken && atTopLevel && tokenStart === bodyOpen;
};

const normalizedTokenText = (token: ts.SyntaxKind, text: string): string =>
  token === ts.SyntaxKind.Identifier || token === ts.SyntaxKind.PrivateIdentifier ? text.normalize('NFC') : text;

const nextSignatureDepths = (token: ts.SyntaxKind, depths: SignatureDepths): SignatureDepths => {
  if (token === ts.SyntaxKind.OpenParenToken) {
    return { ...depths, parenthesis: depths.parenthesis + 1 };
  }
  if (token === ts.SyntaxKind.CloseParenToken && depths.parenthesis > 0) {
    return { ...depths, parenthesis: depths.parenthesis - 1 };
  }
  if (token === ts.SyntaxKind.OpenBracketToken) {
    return { ...depths, bracket: depths.bracket + 1 };
  }
  if (token === ts.SyntaxKind.CloseBracketToken && depths.bracket > 0) {
    return { ...depths, bracket: depths.bracket - 1 };
  }
  if (token === ts.SyntaxKind.OpenBraceToken) {
    return { ...depths, brace: depths.brace + 1 };
  }
  if (token === ts.SyntaxKind.CloseBraceToken && depths.brace > 0) {
    return { ...depths, brace: depths.brace - 1 };
  }
  return depths;
};

const isArrowFunctionEnd = (
  token: ts.SyntaxKind,
  atTopLevel: boolean,
  node: ts.Node,
): boolean => token === ts.SyntaxKind.EqualsGreaterThanToken && atTopLevel && ts.isArrowFunction(node);

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
  let depths: SignatureDepths = { parenthesis: 0, bracket: 0, brace: 0 };

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const atTopLevel = isTopLevel(depths);
    const tokenStart = scanner.getTokenStart();
    if (endsSignature({ token, tokenStart, atTopLevel, bodyOpen, initializerEquals })) break;

    tokens.push(normalizedTokenText(token, scanner.getTokenText()));
    depths = nextSignatureDepths(token, depths);
    if (isArrowFunctionEnd(token, atTopLevel, node)) break;
  }

  return tokens.join(' ');
};
