import type { SymbolKind } from '../types/index.js';

export interface StructuredSource {
  readonly filePath: string;
  readonly language: string;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface SymbolPosition {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface SymbolMetadata {
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly signatureDiscriminator: string;
  readonly position: SymbolPosition;
}

export interface StructuredDeclaration extends SymbolMetadata {
  readonly name: string;
  readonly symbolId: string;
  readonly content: string;
}

export interface StructuredImport {
  readonly source: string;
  readonly importedNames: readonly string[];
  readonly position: SymbolPosition;
}

export interface StructuredGeneration {
  readonly generationId: string;
  readonly schemaVersion: 1;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly contentHash: string;
}

export const structuredRetrievalStatus = {
  ok: 'ok',
  degraded: 'degraded',
  unsupported: 'unsupported',
  failed: 'failed',
} as const;
export type StructuredRetrievalStatus = typeof structuredRetrievalStatus[keyof typeof structuredRetrievalStatus];

export type StructuredFileState =
  | { readonly status: 'exact'; readonly retrievability: 'complete' }
  | { readonly status: 'degraded'; readonly retrievability: 'partial' }
  | { readonly status: 'unsupported'; readonly retrievability: 'none' };

export const structuredRetrievalReasonCode = {
  parseError: 'parse_error',
  unsupportedLanguage: 'unsupported_language',
  invalidUtf8: 'invalid_utf8',
  invariantViolation: 'invariant_violation',
} as const;
export type StructuredRetrievalReasonCode = typeof structuredRetrievalReasonCode[keyof typeof structuredRetrievalReasonCode];

export type StructuredParseResult = {
  readonly declarations: readonly StructuredDeclaration[];
  readonly imports: readonly StructuredImport[];
  readonly generation?: StructuredGeneration;
  readonly error?: string;
} & (
  | { readonly status: 'ok'; readonly retrievability: 'exact'; readonly reasonCode?: never }
  | { readonly status: 'degraded'; readonly retrievability: 'partial'; readonly reasonCode: StructuredRetrievalReasonCode }
  | { readonly status: 'unsupported'; readonly retrievability: 'none'; readonly reasonCode: StructuredRetrievalReasonCode }
  | { readonly status: 'failed'; readonly retrievability: 'none'; readonly reasonCode: StructuredRetrievalReasonCode }
);
