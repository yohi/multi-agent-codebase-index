import { createHash } from 'node:crypto';

export const createGenerationId = (input: {
  readonly schemaVersion: 1;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly contentHash: string;
}): string => createHash('sha256').update(JSON.stringify([
  input.schemaVersion,
  input.parserId,
  input.parserVersion,
  input.contentHash,
]), 'utf8').digest('base64url');

export const createSymbolId = (input: {
  readonly filePath: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly signatureDiscriminator: string;
  readonly occurrence: number;
}): string => `symbol_v1_${createHash('sha256').update(JSON.stringify([
  1,
  input.filePath,
  input.qualifiedName,
  input.kind,
  input.signatureDiscriminator,
  input.occurrence,
]), 'utf8').digest('base64url')}`;
