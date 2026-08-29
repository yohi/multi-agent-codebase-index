import ts from 'typescript';
import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile, SymbolKind } from '../../types/index.js';
import { sha256Hex } from '../../structured/hash.js';
import { createUtf8OffsetTable } from '../../structured/utf8-offsets.js';
import type { StructuredDeclaration, StructuredImport, StructuredLanguageParser, StructuredParseResult, StructuredSource } from '../../structured/contracts.js';

const getLineRange = (sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } => {
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getFullStart()).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { startLine, endLine };
};

/**
 * Defensive helper that correctly detects whether a node has an implementation.
 * Returns true only when node.body exists, the source file is not a declaration file,
 * and the node does not have an abstract modifier.
 */
const hasImplementation = (node: ts.Node): boolean => {
  const anyNode = node as any;
  if (!anyNode.body) {
    return false;
  }

  if (node.getSourceFile().isDeclarationFile === true) {
    return false;
  }

  if (anyNode.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.AbstractKeyword)) {
    return false;
  }

  return true;
};

class TypeScriptParser {
  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    const sourceFile = ts.createSourceFile(source.filePath, source.text, ts.ScriptTarget.Latest, true);
    const offsets = createUtf8OffsetTable(source.text);
    const declarations: StructuredDeclaration[] = [];
    const imports: StructuredImport[] = [];
    const diagnostics: readonly ts.Diagnostic[] = [];
    const visit = (node: ts.Node, parents: readonly string[]) => {
      const named = (node as ts.NamedDeclaration).name;
      const name = named && ts.isIdentifier(named) ? named.text : undefined;
      let kind: SymbolKind | undefined;
      if (ts.isClassDeclaration(node)) kind = 'class';
      else if (ts.isInterfaceDeclaration(node)) kind = 'interface';
      else if (ts.isFunctionDeclaration(node)) kind = 'function';
      else if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) kind = 'method';
      else if (ts.isConstructorDeclaration(node)) kind = 'constructor';
      else if (ts.isEnumDeclaration(node)) kind = 'enum';
      else if (ts.isTypeAliasDeclaration(node)) kind = 'typeAlias';
      else if (ts.isPropertyDeclaration(node)) kind = 'property';
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) kind = 'variable';
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
        imports.push({ id: sha256Hex(new TextEncoder().encode(`${source.filePath}:${node.getStart(sourceFile)}:${moduleSpecifier ?? ''}`)), moduleSpecifier, startByte: offsets.byteOffsetAtUtf16(node.getStart(sourceFile)), endByte: offsets.byteOffsetAtUtf16(node.end), sourceHash: sha256Hex(source.bytes.subarray(offsets.byteOffsetAtUtf16(node.getStart(sourceFile)), offsets.byteOffsetAtUtf16(node.end))), completeness: diagnostics.length === 0 ? 'complete' : 'partial', diagnostics: diagnostics.map((item) => item.messageText), position: { startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, startColumn: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).character, endLine: sourceFile.getLineAndCharacterOfPosition(node.end).line + 1, endColumn: sourceFile.getLineAndCharacterOfPosition(node.end).character } });
      }
      if (kind && name) {
        const qualifiedName = [...parents, name].join('.');
        const start = node.getFullStart();
        const end = node.end;
        const startByte = offsets.byteOffsetAtUtf16(start);
        const endByte = offsets.byteOffsetAtUtf16(end);
        const signatureDiscriminator = source.text.slice(node.getStart(sourceFile), Math.min(end, node.getStart(sourceFile) + 256)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
        declarations.push({ symbolId: sha256Hex(new TextEncoder().encode(`${qualifiedName}:${signatureDiscriminator}`)), qualifiedName, kind, signatureDiscriminator, position: { startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1, startColumn: sourceFile.getLineAndCharacterOfPosition(start).character, endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1, endColumn: sourceFile.getLineAndCharacterOfPosition(end).character }, name, startByte, endByte, sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)), parentSymbolId: parents.length > 0 ? sha256Hex(new TextEncoder().encode(parents.join('.'))) : undefined, languageId: source.language, isExact: diagnostics.length === 0, rawSource: source.text.slice(start, end) });
      }
      const nextParents = kind && name && (ts.isClassDeclaration(node) || ts.isModuleDeclaration(node) || ts.isNamespaceExportDeclaration(node)) ? [...parents, name] : parents;
      ts.forEachChild(node, (child) => visit(child, nextParents));
    };
    visit(sourceFile, []);
    const generation = { generationId: sha256Hex(source.bytes), schemaVersion: 1 as const, parserId: 'typescript', parserVersion: ts.version, fileHash: sha256Hex(source.bytes), fileCompleteness: diagnostics.length === 0 ? 'complete' as const : 'partial' as const, fileDiagnostics: diagnostics.map((item: ts.Diagnostic) => item.messageText) };
    if (diagnostics.length === 0) return { status: 'ok', retrievability: 'exact', declarations, imports, generation };
    return { status: 'degraded', retrievability: 'exact', declarations, imports, generation, failure: { reasonCode: 'parse_error', message: 'TypeScript parse diagnostics were reported.' } };
  }
  async parse(file: FileToChunk): Promise<ParsedSourceFile> {
    const sourceFile = ts.createSourceFile(file.filePath, file.content, ts.ScriptTarget.Latest, true);
    const declarations: ParsedDeclaration[] = [];
    const importNodes: ts.ImportDeclaration[] = [];

    const visit = (node: ts.Node) => {
      let type: SymbolKind | undefined;
      let name: string | undefined;

      if (ts.isImportDeclaration(node)) {
        importNodes.push(node);
      } else if (ts.isInterfaceDeclaration(node)) {
        type = 'interface';
        name = node.name.text;
      } else if (ts.isFunctionDeclaration(node) && hasImplementation(node)) {
        type = 'function';
        name = node.name ? node.name.text : '<anonymous>';
      } else if (ts.isClassDeclaration(node)) {
        type = 'class';
        name = node.name ? node.name.text : '<anonymous>';
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && hasImplementation(node)) {
        type = 'method';
        name = node.name.text;
      } else if (ts.isConstructorDeclaration(node) && hasImplementation(node)) {
        type = 'constructor';
        name = 'constructor';
      } else if (ts.isGetAccessorDeclaration(node) && ts.isIdentifier(node.name) && hasImplementation(node)) {
        type = 'method';
        name = `get ${node.name.text}`;
      } else if (ts.isSetAccessorDeclaration(node) && ts.isIdentifier(node.name) && hasImplementation(node)) {
        type = 'method';
        name = `set ${node.name.text}`;
      } else if (ts.isEnumDeclaration(node)) {
        type = 'enum';
        name = node.name.text;
      } else if (ts.isTypeAliasDeclaration(node)) {
        type = 'typeAlias';
        name = node.name.text;
      } else if (ts.isModuleDeclaration(node)) {
        type = 'namespace';
        name = node.name.text;
      } else if (ts.isExportAssignment(node)) {
        // Handle export default expressions
        const expression = node.expression;
        if (ts.isFunctionExpression(expression)) {
          type = 'function';
          name = expression.name ? expression.name.text : '<anonymous>';
        } else if (ts.isArrowFunction(expression)) {
          type = 'function';
          name = '<anonymous>';
        } else if (ts.isClassExpression(expression)) {
          type = 'class';
          name = expression.name ? expression.name.text : '<anonymous>';
        } else if (ts.isIdentifier(expression)) {
          type = 'unknown';
          name = expression.text;
        } else {
          type = 'unknown';
          name = '<anonymous>';
        }
      } else if (ts.isVariableStatement(node)) {
        const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (isExported) {
          for (const declaration of node.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              const varName = declaration.name.text;
              const { startLine, endLine } = getLineRange(sourceFile, declaration);
              const content = sourceFile.getFullText().slice(declaration.getFullStart(), declaration.getEnd()).trim();

              let varType: SymbolKind = 'variable';
              if (declaration.initializer) {
                if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
                  varType = 'function';
                } else if (ts.isCallExpression(declaration.initializer)) {
                  const hasFunctionArg = declaration.initializer.arguments.some(
                    (arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
                  );
                  if (hasFunctionArg) {
                    varType = 'function';
                  }
                }
              }

              declarations.push({
                type: varType,
                name: varName,
                startLine,
                endLine,
                content,
              });
            }
          }
        }
      }

      if (type && name) {
        const { startLine, endLine } = getLineRange(sourceFile, node);
        declarations.push({
          type,
          name,
          startLine,
          endLine,
          content: sourceFile.getFullText().slice(node.getFullStart(), node.getEnd()).trim(),
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (importNodes.length > 0) {
      const firstImport = importNodes[0];
      const lastImport = importNodes[importNodes.length - 1];

      if (firstImport && lastImport) {
        const { startLine } = getLineRange(sourceFile, firstImport);
        const { endLine } = getLineRange(sourceFile, lastImport);

        declarations.push({
          type: 'import',
          name: 'imports',
          startLine,
          endLine,
          content: importNodes
            .map((n) => sourceFile.getFullText().slice(n.getFullStart(), n.getEnd()).trim())
            .join('\n'),
        });
      }
    }

    declarations.sort((left, right) => left.startLine - right.startLine);

    return {
      rootType: 'program',
      declarations,
    };
  }
}

export class TypeScriptLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'typescript';

  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createParser(): Promise<TypeScriptParser> {
    return new TypeScriptParser();
  }

  async createStructuredParser(): Promise<StructuredLanguageParser> {
    return new TypeScriptParser();
  }
}
