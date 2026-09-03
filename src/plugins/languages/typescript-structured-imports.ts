import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { StructuredImport, StructuredSource } from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import type { Utf8OffsetTable } from '../../structured/utf8-offsets.js';
import { flattenDiagnosticMessage } from './typescript-structured-diagnostics.js';

export interface StructuredImportContext {
  readonly source: StructuredSource;
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly diagnostics: readonly ts.Diagnostic[];
  readonly offsets: Utf8OffsetTable;
}

const appendBindingNames = (name: ts.BindingName, names: Set<string>): void => {
  if (ts.isIdentifier(name)) {
    names.add(name.text.normalize('NFC'));
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) appendBindingNames(element.name, names);
  }
};

const topLevelLocalNames = (sourceFile: ts.SourceFile): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        appendBindingNames(declaration.name, names);
      }
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      if (statement.name) names.add(statement.name.text.normalize('NFC'));
    }
  }
  return names;
};

const importBindingNodes = (node: ts.ImportDeclaration): readonly (ts.Identifier | undefined)[] => {
  const clause = node.importClause;
  if (clause === undefined) return [undefined];
  const bindings: Array<ts.Identifier | undefined> = [];
  if (clause.name) bindings.push(clause.name);
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    bindings.push(clause.namedBindings.name);
  } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) bindings.push(element.name);
  }
  return bindings.length === 0 ? [undefined] : bindings;
};

const bindingResolvesUnambiguously = (
  checker: ts.TypeChecker,
  nameNode: ts.Identifier | undefined,
): boolean => {
  if (nameNode === undefined) return true;
  const symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol === undefined || symbol.declarations?.length !== 1 || symbol.flags !== ts.SymbolFlags.Alias) {
    return false;
  }
  return (checker.getAliasedSymbol(symbol).declarations?.length ?? 0) > 0;
};

const importsForNode = (
  context: StructuredImportContext,
  node: ts.ImportDeclaration,
  localNames: ReadonlySet<string>,
): readonly StructuredImport[] => {
  const { source, sourceFile, checker, diagnostics, offsets } = context;
  const moduleSpecifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
  const moduleResolves = checker.getSymbolAtLocation(node.moduleSpecifier) !== undefined;
  const start = node.getStart(sourceFile);
  const end = node.end;
  const startByte = offsets.byteOffsetAtUtf16(start);
  const endByte = offsets.byteOffsetAtUtf16(end);
  const position = {
    startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
    startColumn: sourceFile.getLineAndCharacterOfPosition(start).character,
    endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
    endColumn: sourceFile.getLineAndCharacterOfPosition(end).character,
  };

  return importBindingNodes(node).map((nameNode) => {
    const bindingName = nameNode?.text.normalize('NFC');
    const shadowed = bindingName !== undefined && localNames.has(bindingName);
    const complete =
      diagnostics.length === 0 &&
      moduleSpecifier !== undefined &&
      moduleResolves &&
      bindingResolvesUnambiguously(checker, nameNode) &&
      !shadowed;
    const importKey = `${source.filePath}:${start}:${moduleSpecifier ?? ''}:${bindingName ?? ''}`;
    return {
      id: `import_v1_${createHash('sha256').update(importKey, 'utf8').digest('base64url')}`,
      ...(moduleSpecifier === undefined ? {} : { moduleSpecifier }),
      ...(bindingName === undefined ? {} : { bindingName }),
      startByte,
      endByte,
      sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
      completeness: complete ? 'complete' : 'partial',
      diagnostics: diagnostics.map((diagnostic) => flattenDiagnosticMessage(diagnostic.messageText)),
      position,
    };
  });
};

export const collectStructuredImports = (context: StructuredImportContext): readonly StructuredImport[] => {
  const localNames = topLevelLocalNames(context.sourceFile);
  return context.sourceFile.statements
    .filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement))
    .flatMap((node) => importsForNode(context, node, localNames));
};
