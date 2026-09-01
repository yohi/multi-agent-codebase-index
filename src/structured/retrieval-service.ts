import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IStructuredCatalog, StructuredImportRecord, StructuredIndexState } from '../storage/interfaces/structured-catalog.js';
import type { PathSanitizer } from '../server/path-sanitizer.js';
import { sha256Hex, decodeUtf8 } from './hash.js';
import type { StructuredDeclaration, StructuredRetrievalReasonCode } from './contracts.js';
import type { StructuredTombstone } from '../storage/interfaces/structured-catalog.js';
import { packRelatedImports, tokenCounter } from './tokenizer.js';

type SourceStatus =
  | { status: 'ok'; freshness: 'fresh'; source: string }
  | { status: 'index_incomplete'; reasonCode: StructuredRetrievalReasonCode | 'INDEX_PENDING_GENERATION' | 'INDEX_FILE_HASH_MISMATCH' | 'INDEX_IMPORT_HASH_MISMATCH' | 'SYMBOL_RETIRED' | 'STRUCTURED_INDEX_MISSING' | 'FILE_NOT_FOUND' | 'INDEX_FILE_MISSING' }
  | { status: 'stale'; reasonCode: StructuredRetrievalReasonCode | 'INDEX_FILE_HASH_MISMATCH' | 'INDEX_IMPORT_HASH_MISMATCH' | 'INDEX_FILE_MISSING' | 'PATH_EXCLUDED' }
  | { status: 'not_found'; reasonCode: 'FILE_NOT_FOUND' | 'SYMBOL_RETIRED' | 'STRUCTURED_INDEX_MISSING' }
  | { status: 'excluded'; reasonCode: 'PATH_EXCLUDED' }
  | { status: 'unsupported'; reasonCode: 'unsupported_language' | 'STRUCTURED_SCHEMA_UNSUPPORTED' }
  | { status: 'failed'; reasonCode: 'parse_error' | 'invariant_violation' }
  | { status: 'not_indexed'; reasonCode: 'STRUCTURED_INDEX_MISSING' | 'STRUCTURED_SCHEMA_UNSUPPORTED' };

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
      return domain;
    }

    const resolution = await this.options.catalog.resolveFile(relativePath);
    if (resolution.kind === 'missing') {
      return { status: 'not_found', reasonCode: 'FILE_NOT_FOUND', request: { filePath: input.filePath } };
    }

    if (resolution.kind === 'pending') {
      return {
        status: 'index_incomplete',
        reasonCode: 'INDEX_PENDING_GENERATION',
        request: { filePath: input.filePath },
      };
    }

    // For active files, return source-free outline metadata.
    const declarations = await this.options.catalog.getFileDeclarations(relativePath);
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

    return { status: 'ok', filePath: relativePath, generationId: resolution.generationId, symbols };
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

    const filePath = verified.filePath;
    const importsCompleteness = this.mergeCompleteness(importRecords);

    return {
      status: 'ok',
      freshness: 'fresh',
      context: packed.context,
      filePath,
      imports: packed.imports.map((item) => ({
        id: item.id,
        moduleSpecifier: this.extractModuleSpecifier(item.id),
        startByte: item.startByte,
        rawSource: item.rawSource,
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

    const projectRoot = this.options.sanitizer.getProjectRoot();
    const readResult = await this.readCurrentBytes(filePath, projectRoot);
    if (readResult.status !== 'ok') {
      return { ok: false, status: { status: 'stale', reasonCode: readResult.reasonCode, request: { symbolId: input.symbolId } } };
    }

    const symbolSlice = readResult.bytes.subarray(resolution.declaration.startByte, resolution.declaration.endByte);
    const sliceHash = sha256Hex(symbolSlice);
    if (sliceHash !== resolution.declaration.sourceHash) {
      return { ok: false, status: { status: 'stale', reasonCode: 'INDEX_FILE_HASH_MISMATCH', request: { symbolId: input.symbolId } } };
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

  private extractModuleSpecifier(id: string): string | undefined {
    const parts = id.split('\u0000');
    return parts[0] || undefined;
  }

  private async readCurrentBytes(filePath: string, projectRoot: string): Promise<{ status: 'ok'; bytes: Uint8Array } | { status: 'stale'; reasonCode: 'INDEX_FILE_MISSING' | 'PATH_EXCLUDED' }> {
    if (this.options.isExcluded) {
      const excluded = await this.options.isExcluded(filePath);
      if (excluded) return { status: 'stale', reasonCode: 'PATH_EXCLUDED' };
    }
    try {
      const absolutePath = join(projectRoot, filePath);
      const buffer = await readFile(absolutePath);
      return { status: 'ok', bytes: new Uint8Array(buffer) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { status: 'stale', reasonCode: 'INDEX_FILE_MISSING' };
      }
      throw error;
    }
  }

  private checkGlobalState(state: StructuredIndexState): { status: 'not_indexed'; reasonCode: 'STRUCTURED_INDEX_MISSING' | 'STRUCTURED_SCHEMA_UNSUPPORTED' } | undefined {
    if (state.schemaVersion === null) {
      return { status: 'not_indexed', reasonCode: 'STRUCTURED_INDEX_MISSING' };
    }
    if (state.schemaVersion !== 1) {
      return { status: 'not_indexed', reasonCode: 'STRUCTURED_SCHEMA_UNSUPPORTED' };
    }
    return undefined;
  }
}
