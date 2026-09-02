import path from 'node:path';
import ts from 'typescript';
import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredLanguageParser,
  StructuredParseResult,
  StructuredSource,
} from '../../structured/contracts.js';
import { sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import { createUtf8OffsetTable } from '../../structured/utf8-offsets.js';
import {
  describeDeclaration,
} from './typescript-structured-declarations.js';
import { declarationStart, signatureFor } from './typescript-structured-signatures.js';
import { collectStructuredImports } from './typescript-structured-imports.js';

interface ProgramContext {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly diagnostics: readonly ts.Diagnostic[];
}

const createProgramContext = (source: StructuredSource): ProgramContext => {
  const absolutePath = path.resolve(source.filePath);
  const options = {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
    types: [],
  } satisfies ts.CompilerOptions;
  const rootSourceFile = ts.createSourceFile(
    absolutePath,
    source.text,
    ts.ScriptTarget.Latest,
    true,
  );
  const host = ts.createCompilerHost(options, true);
  const fallbackGetSourceFile = host.getSourceFile.bind(host);
  const isRootFile = (fileName: string): boolean => path.resolve(fileName) === absolutePath;

  host.fileExists = (fileName) => isRootFile(fileName) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => isRootFile(fileName) ? source.text : ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    isRootFile(fileName)
      ? rootSourceFile
      : fallbackGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);

  const program = ts.createProgram([absolutePath], options, host);
  const sourceFile = program.getSourceFile(absolutePath) ?? rootSourceFile;
  return {
    sourceFile,
    checker: program.getTypeChecker(),
    diagnostics: program.getSyntacticDiagnostics(sourceFile),
  };
};

const intersectsDiagnostic = (
  diagnostics: readonly ts.Diagnostic[],
  start: number,
  end: number,
): boolean => diagnostics.some((diagnostic) =>
  diagnostic.start !== undefined &&
  diagnostic.length !== undefined &&
  diagnostic.start < end &&
  diagnostic.start + diagnostic.length > start,
);

const generationFor = (
  source: StructuredSource,
  diagnostics: readonly ts.Diagnostic[],
): StructuredGeneration => ({
  generationId: sha256Hex(source.bytes),
  schemaVersion: 1,
  parserId: 'typescript',
  parserVersion: ts.version,
  fileHash: sha256Hex(source.bytes),
  fileCompleteness: diagnostics.length === 0 ? 'complete' : 'partial',
  fileDiagnostics: diagnostics.map((diagnostic) => diagnostic.messageText),
});

export class TypeScriptStructuredParser implements StructuredLanguageParser {
  async parseStructured(source: StructuredSource): Promise<StructuredParseResult> {
    const { sourceFile, checker, diagnostics } = createProgramContext(source);
    const offsets = createUtf8OffsetTable(source.text);
    const drafts: StructuredDeclaration[] = [];
    const occurrenceCounts = new Map<string, number>();

    const visit = (node: ts.Node, parents: readonly string[], ancestorHasDiagnostic: boolean): void => {
      const descriptor = describeDeclaration(node);
      const start = descriptor ? declarationStart(sourceFile, descriptor.rangeStartNode) : node.getStart(sourceFile);
      const hasDiagnostic = descriptor !== undefined && intersectsDiagnostic(diagnostics, start, node.end);

      if (descriptor && !ancestorHasDiagnostic && !hasDiagnostic) {
        const qualifiedName = [...parents, descriptor.name].join('.');
        const signatureDiscriminator = signatureFor(sourceFile, descriptor);
        const occurrenceKey = `${qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
        const occurrence = occurrenceCounts.get(occurrenceKey) ?? 0;
        occurrenceCounts.set(occurrenceKey, occurrence + 1);
        const startByte = offsets.byteOffsetAtUtf16(start);
        const endByte = offsets.byteOffsetAtUtf16(node.end);
        drafts.push({
          symbolId: createSymbolId({
            filePath: source.filePath,
            qualifiedName,
            kind: descriptor.kind,
            signatureDiscriminator,
            occurrence,
          }),
          qualifiedName,
          kind: descriptor.kind,
          signatureDiscriminator,
          position: {
            startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
            startColumn: sourceFile.getLineAndCharacterOfPosition(start).character,
            endLine: sourceFile.getLineAndCharacterOfPosition(node.end).line + 1,
            endColumn: sourceFile.getLineAndCharacterOfPosition(node.end).character,
          },
          name: descriptor.name,
          startByte,
          endByte,
          sourceHash: sha256Hex(source.bytes.subarray(startByte, endByte)),
          languageId: source.language,
          isExact: true,
          rawSource: source.text.slice(start, node.end),
        });
      }

      const childParents = descriptor?.createsScope ? [...parents, descriptor.name] : parents;
      const childHasDiagnostic = ancestorHasDiagnostic || Boolean(descriptor?.createsScope && hasDiagnostic);
      ts.forEachChild(node, (child) => visit(child, childParents, childHasDiagnostic));
    };

    visit(sourceFile, [], false);
    const symbolByQualifiedName = new Map(drafts.map((declaration) => [declaration.qualifiedName, declaration.symbolId]));
    const declarations = drafts.map((declaration): StructuredDeclaration => {
      const separator = declaration.qualifiedName.lastIndexOf('.');
      const parentSymbolId = separator > 0
        ? symbolByQualifiedName.get(declaration.qualifiedName.slice(0, separator))
        : undefined;
      return parentSymbolId ? { ...declaration, parentSymbolId } : declaration;
    });
    const imports = collectStructuredImports({ source, sourceFile, checker, diagnostics, offsets });
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
      failure: { reasonCode: 'parse_error', message: 'TypeScript parse diagnostics were reported.' },
    };
  }
}
