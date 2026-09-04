import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  IStructuredCatalog,
  StructuredImportRecord,
  StructuredIndexState,
  StructuredTombstone,
} from '../storage/interfaces/structured-catalog.js';
import type { PathSanitizer } from '../server/path-sanitizer.js';
import { sha256Hex, decodeUtf8 } from './hash.js';
import type { StructuredDeclaration, StructuredRetrievalReasonCode } from './contracts.js';
import { packRelatedImports, tokenCounter } from './tokenizer.js';

type SourceStatus =
  | { status: 'ok'; freshness: 'fresh'; source: string }
  | { status: 'index_incomplete'; reasonCode: StructuredRetrievalReasonCode | 'INDEX_PENDING_GENERATION' | 'INDEX_FILE_HASH_MISMATCH' | 'INDEX_IMPORT_HASH_MISMATCH' | 'INDEX_SYMBOL_HASH_MISMATCH' | 'INDEX_GENERATION_MISSING' | 'SYMBOL_RETIRED' | 'STRUCTURED_INDEX_MISSING' | 'FILE_NOT_FOUND' | 'INDEX_FILE_MISSING' }
  | { status: 'stale'; reasonCode: StructuredRetrievalReasonCode | 'INDEX_FILE_HASH_MISMATCH' | 'INDEX_IMPORT_HASH_MISMATCH' | 'INDEX_FILE_MISSING' | 'PATH_EXCLUDED' }
  | { status: 'not_found'; reasonCode: 'FILE_NOT_FOUND' | 'SYMBOL_RETIRED' | 'STRUCTURED_INDEX_MISSING' }
  | { status: 'excluded'; reasonCode: 'PATH_EXCLUDED' }
  | { status: 'unsupported'; reasonCode: 'unsupported_language' | 'STRUCTURED_SCHEMA_UNSUPPORTED' }
  | { status: 'failed'; reasonCode: 'parse_error' | 'invariant_violation' }
  | { status: 'not_indexed'; reasonCode: 'STRUCTURED_INDEX_MISSING' | 'STRUCTURED_SCHEMA_UNSUPPORTED' };

type GlobalStateStatus =
  | {
      readonly status: 'not_indexed';
      readonly freshness: 'unknown';
      readonly reindexRequired: true;
      readonly reasonCode: 'STRUCTURED_INDEX_MISSING';
    }
  | {
      readonly status: 'unsupported';
      readonly freshness: 'unknown';
      readonly reindexRequired: false;
      readonly reasonCode: 'STRUCTURED_SCHEMA_UNSUPPORTED';
    };

type VerifiedSymbol =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly declaration: StructuredDeclaration; readonly filePath: string }
  | { readonly ok: false; readonly status: SourceStatus & { request?: { symbolId: string } } };

export interface SymbolRetrievalServiceOptions {
  catalog: IStructuredCatalog;
  sanitizer: PathSanitizer;
  isExcluded?: (filePath: string) => boolean | Promise<boolean>;
  isSupportedLanguage?: (language: string) => boolean;
}

export class SymbolRetrievalService {
  constructor(private readonly options: SymbolRetrievalServiceOptions) {}

  async getFileOutline(input: { filePath: string; signal?: AbortSignal }): Promise<unknown> {
    const relativePath = this.options.sanitizer.validateProjectRelative(input.filePath);
    const state = await this.options.catalog.getStructuredIndexState();
    const domain = this.checkGlobalState(state);
    if (domain !== undefined) {
      return { ...domain, request: { filePath: input.filePath } };
    }

    if (this.options.isExcluded) {
      const excluded = await this.options.isExcluded(relativePath);
      if (excluded) {
        return {
          status: 'excluded',
          freshness: 'unknown',
          reindexRequired: false,
          reasonCode: 'PATH_EXCLUDED',
          request: { filePath: input.filePath },
        };
      }
    }

    const projectRoot = this.options.sanitizer.getProjectRoot();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resolution = await this.options.catalog.resolveFile(relativePath);
      if (resolution.kind === 'pending') {
        return {
          status: 'index_incomplete',
          freshness: 'unknown',
          reindexRequired: true,
          reasonCode: 'INDEX_PENDING_GENERATION',
          request: { filePath: input.filePath },
        };
      }

      const readResult = await this.readCurrentBytes(relativePath, projectRoot, input.signal);
      if (resolution.kind === 'missing') {
        if (readResult.status !== 'ok') {
          return {
            status: 'not_found',
            freshness: 'unknown',
            reindexRequired: false,
            reasonCode: 'FILE_NOT_FOUND',
            request: { filePath: input.filePath },
          };
        }
        return {
          status: 'not_indexed',
          freshness: 'unknown',
          reindexRequired: true,
          reasonCode: 'STRUCTURED_INDEX_MISSING',
          request: { filePath: input.filePath },
        };
      }

      // Active file: verify freshness before returning metadata.
      if (readResult.status !== 'ok') {
        return {
          status: 'stale',
          freshness: 'stale',
          reindexRequired: true,
          reasonCode: readResult.reasonCode,
          request: { filePath: input.filePath },
        };
      }

      const generation = await this.options.catalog.getGeneration(relativePath, resolution.generationId);
      if (generation === null) {
        if (attempt === 0) {
          continue;
        }
        return {
          status: 'index_incomplete',
          freshness: 'unknown',
          reindexRequired: true,
          reasonCode: 'INDEX_GENERATION_MISSING',
          request: { filePath: input.filePath },
        };
      }

      const fileHash = sha256Hex(readResult.bytes);
      if (fileHash !== generation.fileHash) {
        const currentResolution = await this.options.catalog.resolveFile(relativePath);
        if (attempt === 0 && currentResolution.kind === 'active' && currentResolution.generationId !== resolution.generationId) {
          continue;
        }
        return {
          status: 'stale',
          freshness: 'stale',
          reindexRequired: true,
          reasonCode: 'INDEX_FILE_HASH_MISMATCH',
          request: { filePath: input.filePath },
        };
      }

      if (this.options.isSupportedLanguage && !this.options.isSupportedLanguage(generation.parserId)) {
        const currentResolution = await this.options.catalog.resolveFile(relativePath);
        if (attempt === 0 && currentResolution.kind === 'active' && currentResolution.generationId !== resolution.generationId) {
          continue;
        }
        return {
          status: 'unsupported',
          freshness: 'unknown',
          reindexRequired: false,
          reasonCode: 'unsupported_language',
          request: { filePath: input.filePath },
        };
      }

      const declarations = await this.options.catalog.getFileDeclarations(relativePath);
      const currentResolution = await this.options.catalog.resolveFile(relativePath);
      if (currentResolution.kind !== 'active' || currentResolution.generationId !== resolution.generationId) {
        if (attempt === 0) {
          continue;
        }
        return {
          status: 'stale',
          freshness: 'stale',
          reindexRequired: true,
          reasonCode: 'INDEX_FILE_HASH_MISMATCH',
          request: { filePath: input.filePath },
        };
      }

      const symbols = declarations.map((declaration) => ({
        name: declaration.name,
        qualifiedName: declaration.qualifiedName,
        symbolId: declaration.symbolId,
        kind: declaration.kind,
        signatureDiscriminator: declaration.signatureDiscriminator,
        position: declaration.position,
        isExact: declaration.isExact,
        languageId: declaration.languageId,
      }));

      return {
        ...(generation.fileCompleteness === 'partial'
          ? { status: 'degraded', retrievability: 'partial', reasonCode: 'PARSER_COVERAGE_PARTIAL' }
          : { status: 'ok' }),
        freshness: 'fresh',
        reindexRequired: false,
        file: {
          filePath: relativePath,
          language: generation.parserId,
          parserId: generation.parserId,
          parserVersion: generation.parserVersion,
        },
        symbols,
        request: { filePath: input.filePath },
      };
    }

    return {
      status: 'index_incomplete',
      freshness: 'unknown',
      reindexRequired: true,
      reasonCode: 'INDEX_GENERATION_MISSING',
      request: { filePath: input.filePath },
    };
  }

  async getSymbolSource(input: { symbolId: string; signal?: AbortSignal }): Promise<SourceStatus & { request?: { symbolId: string } }> {
    const verified = await this.verifySymbol(input);
    if (!verified.ok) {
      return verified.status;
    }

    const symbolSlice = verified.bytes.subarray(verified.declaration.startByte, verified.declaration.endByte);
    const source = decodeUtf8(symbolSlice);
    return { status: 'ok', freshness: 'fresh', source, request: { symbolId: input.symbolId } };
  }

  async getSymbolContext(input: { symbolId: string; tokenBudget: number; signal?: AbortSignal }): Promise<unknown> {
    const verified = await this.verifySymbol(input);
    if (!verified.ok) {
      return { ...verified.status, request: { symbolId: input.symbolId, tokenBudget: input.tokenBudget } };
    }

    const symbolSlice = verified.bytes.subarray(verified.declaration.startByte, verified.declaration.endByte);
    const symbolSource = decodeUtf8(symbolSlice);

    const importRecords = await this.options.catalog.getImportsForSymbol(input.symbolId);
    const candidates = this.verifyImports(verified.bytes, importRecords);
    if (!candidates.ok) {
      return { ...candidates.status, request: { symbolId: input.symbolId, tokenBudget: input.tokenBudget } };
    }

    const packed = packRelatedImports({
      symbolSource,
      imports: candidates.imports,
      tokenBudget: input.tokenBudget,
    });

    const importsById = new Map(importRecords.map((record) => [record.id, record]));
    const filePath = verified.filePath;
    const importsCompleteness = this.mergeCompleteness(importRecords);

    return {
      status: 'ok',
      freshness: 'fresh',
      context: packed.context,
      filePath,
      imports: packed.imports.map((item) => ({
        id: item.id,
        moduleSpecifier: importsById.get(item.id)?.moduleSpecifier,
        startByte: item.startByte,
        endByte: importsById.get(item.id)?.endByte,
      })),
      importsCompleteness,
      tokenizer: packed.tokenizer,
      tokenizerVersion: packed.tokenizerVersion,
      budget: {
        requested: input.tokenBudget,
        actual: tokenCounter.count(packed.context),
        exceeded: packed.budget.exceeded,
        omittedForBudget: packed.budget.omittedForBudget,
      },
      request: { symbolId: input.symbolId, tokenBudget: input.tokenBudget },
    };
  }

  private async resolveSymbol(symbolId: string): Promise<
    | { readonly kind: 'active'; readonly declaration: StructuredDeclaration; readonly filePath: string }
    | { readonly kind: 'pending'; readonly declaration: StructuredDeclaration }
    | { readonly kind: 'tombstone'; readonly tombstone: StructuredTombstone }
    | { readonly kind: 'missing' }
  > {
    const pending = await this.options.catalog.getPendingSymbol(symbolId);
    if (pending.kind === 'pending') {
      return pending;
    }
    const active = await this.options.catalog.resolveSymbol(symbolId);
    return active;
  }

  private async verifySymbol(input: { symbolId: string; signal?: AbortSignal }): Promise<VerifiedSymbol> {
    const state = await this.options.catalog.getStructuredIndexState();
    const domain = this.checkGlobalState(state);
    if (domain !== undefined) {
      return { ok: false, status: { ...domain, request: { symbolId: input.symbolId } } };
    }

    const resolution = await this.resolveSymbol(input.symbolId);
    if (resolution.kind === 'tombstone') {
      return { ok: false, status: { status: 'not_found', reasonCode: 'SYMBOL_RETIRED', request: { symbolId: input.symbolId } } };
    }
    if (resolution.kind === 'missing') {
      return { ok: false, status: { status: 'not_found', reasonCode: 'FILE_NOT_FOUND', request: { symbolId: input.symbolId } } };
    }
    if (resolution.kind === 'pending') {
      return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_PENDING_GENERATION', request: { symbolId: input.symbolId } } };
    }

    const filePath = resolution.filePath;
    const fileResolution = await this.options.catalog.resolveFile(filePath);
    if (fileResolution.kind === 'pending') {
      return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_PENDING_GENERATION', request: { symbolId: input.symbolId } } };
    }

    const activeGeneration = fileResolution.kind === 'active' ? fileResolution.generationId : undefined;
    if (activeGeneration === undefined) {
      return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_PENDING_GENERATION', request: { symbolId: input.symbolId } } };
    }
    if (this.options.isSupportedLanguage && !this.options.isSupportedLanguage(resolution.declaration.languageId)) {
      return { ok: false, status: { status: 'unsupported', reasonCode: 'unsupported_language', request: { symbolId: input.symbolId } } };
    }

    const generation = await this.options.catalog.getGeneration(filePath, activeGeneration);
    if (generation === null) {
      return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_GENERATION_MISSING', request: { symbolId: input.symbolId } } };
    }

    const projectRoot = this.options.sanitizer.getProjectRoot();
    const readResult = await this.readCurrentBytes(filePath, projectRoot, input.signal);
    if (readResult.status !== 'ok') {
      return { ok: false, status: { status: 'stale', reasonCode: readResult.reasonCode, request: { symbolId: input.symbolId } } };
    }

    const fileHash = sha256Hex(readResult.bytes);
    if (fileHash !== generation.fileHash) {
      return { ok: false, status: { status: 'stale', reasonCode: 'INDEX_FILE_HASH_MISMATCH', request: { symbolId: input.symbolId } } };
    }

    const symbolSlice = readResult.bytes.subarray(resolution.declaration.startByte, resolution.declaration.endByte);
    const sliceHash = sha256Hex(symbolSlice);
    if (sliceHash !== resolution.declaration.sourceHash) {
      return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_SYMBOL_HASH_MISMATCH', request: { symbolId: input.symbolId } } };
    }

    return { ok: true, bytes: readResult.bytes, declaration: resolution.declaration, filePath };
  }

  private verifyImports(
    bytes: Uint8Array,
    importRecords: readonly StructuredImportRecord[],
  ): { ok: true; imports: Array<{ id: string; rawSource: string; startByte: number }> } | { ok: false; status: SourceStatus } {
    const imports: Array<{ id: string; rawSource: string; startByte: number }> = [];
    for (const imported of importRecords) {
      const { startByte, endByte, sourceHash, id } = imported;
      if (startByte < 0 || endByte > bytes.length || startByte >= endByte) {
        return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_IMPORT_HASH_MISMATCH' } };
      }
      const slice = bytes.subarray(startByte, endByte);
      if (sha256Hex(slice) !== sourceHash) {
        return { ok: false, status: { status: 'index_incomplete', reasonCode: 'INDEX_IMPORT_HASH_MISMATCH' } };
      }
      imports.push({ id, rawSource: decodeUtf8(slice), startByte });
    }
    return { ok: true, imports };
  }

  private mergeCompleteness(importRecords: readonly StructuredImportRecord[]): 'complete' | 'partial' {
    return importRecords.every((item) => item.completeness === 'complete') ? 'complete' : 'partial';
  }

  private async readCurrentBytes(
    filePath: string,
    projectRoot: string,
    signal?: AbortSignal,
  ): Promise<{ status: 'ok'; bytes: Uint8Array } | { status: 'stale'; reasonCode: 'INDEX_FILE_MISSING' | 'PATH_EXCLUDED' }> {
    if (this.options.isExcluded) {
      const excluded = await this.options.isExcluded(filePath);
      if (excluded) return { status: 'stale', reasonCode: 'PATH_EXCLUDED' };
    }
    try {
      const absolutePath = join(projectRoot, filePath);
      const buffer = await readFile(absolutePath, { signal });
      return { status: 'ok', bytes: new Uint8Array(buffer) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { status: 'stale', reasonCode: 'INDEX_FILE_MISSING' };
      }
      throw error;
    }
  }

  private checkGlobalState(state: StructuredIndexState): GlobalStateStatus | undefined {
    if (state.schemaVersion === null) {
      return {
        status: 'not_indexed',
        freshness: 'unknown',
        reindexRequired: true,
        reasonCode: 'STRUCTURED_INDEX_MISSING',
      };
    }
    if (state.schemaVersion !== 1) {
      return {
        status: 'unsupported',
        freshness: 'unknown',
        reindexRequired: false,
        reasonCode: 'STRUCTURED_SCHEMA_UNSUPPORTED',
      };
    }
    return undefined;
  }
}
