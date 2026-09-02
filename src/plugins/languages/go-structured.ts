import type Parser from 'tree-sitter';
import type Go from 'tree-sitter-go';

import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredLanguageParser,
  StructuredParseResult,
  StructuredSource,
} from '../../structured/contracts.js';
import { decodeUtf8, sha256Hex } from '../../structured/hash.js';
import { createSymbolId } from '../../structured/identity.js';
import {
  createUtf8OffsetTable,
  failedStructuredSource,
  Utf8SourceError,
} from '../../structured/utf8-offsets.js';
import { declarationsFor } from './go-structured-declarations.js';
import { importsFor } from './go-structured-imports.js';
import {
  diagnosticsFor,
  findDeclarationStartByte,
  hasSyntaxProblem,
  positionFor,
  signatureFor,
} from './go-structured-support.js';

export interface GoTreeSitterRuntime {
  readonly Parser: typeof Parser;
  readonly Go: typeof Go;
}

const generationFor = (
  source: StructuredSource,
  diagnostics: readonly string[],
): StructuredGeneration => ({
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
        failure: {
          reasonCode: 'invariant_violation',
          message: 'Go structured parsing requires original source bytes.',
        },
      };
    }

    const parser = new this.runtime.Parser();
    parser.setLanguage(this.runtime.Go);
    const root = parser.parse(source.text).rootNode;
    let offsets: ReturnType<typeof createUtf8OffsetTable>;
    try {
      offsets = createUtf8OffsetTable(source.text, source.bytes);
    } catch (error) {
      if (error instanceof Utf8SourceError) return failedStructuredSource(error);
      throw error;
    }
    const textLines = source.text.split('\n');
    const diagnostics = diagnosticsFor(root);
    const occurrences = new Map<string, number>();
    const drafts: Array<{
      declaration: StructuredDeclaration;
      ownerTypeName?: string;
    }> = [];

    for (const descriptor of declarationsFor(root)) {
      if (hasSyntaxProblem(descriptor.node)) continue;

      const signatureDiscriminator = signatureFor(source, descriptor.node);
      const occurrenceKey = `${descriptor.qualifiedName}\u0000${descriptor.kind}\u0000${signatureDiscriminator}`;
      const occurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, occurrence + 1);
      const startByte = findDeclarationStartByte(
        textLines,
        descriptor.node.startPosition.row + 1,
        offsets,
      );
      const endByte = offsets.byteOffsetAtUtf16(descriptor.node.endIndex);
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
      drafts.push({ declaration, ownerTypeName: descriptor.ownerTypeName });
    }

    const symbolByName = new Map(
      drafts
      .filter(({ declaration }) => declaration.kind === 'class' || declaration.kind === 'interface')
        .map(({ declaration }) => [declaration.name, declaration.symbolId]),
    );
    const declarations = drafts.map(({ declaration, ownerTypeName }) => {
      const parentSymbolId = ownerTypeName === undefined
        ? undefined
        : symbolByName.get(ownerTypeName);
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
      failure: {
        reasonCode: 'parse_error',
        message: 'Go parse diagnostics were reported.',
      },
    };
  }
}
