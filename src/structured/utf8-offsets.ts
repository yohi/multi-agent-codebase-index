import type { StructuredParseResult } from './contracts.js';
import { decodeUtf8 } from './hash.js';
export interface Utf8OffsetTable {
  readonly byteOffsetAtUtf16: (offset: number) => number;
}

export type Utf8SourceErrorCode = 'invalid_utf8' | 'invariant_violation';

export class Utf8SourceError extends Error {
  override readonly name = 'Utf8SourceError';

  constructor(
    readonly reasonCode: Utf8SourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const failedStructuredSource = (error: Utf8SourceError): StructuredParseResult => ({
  status: 'failed',
  retrievability: 'none',
  declarations: [],
  imports: [],
  failure: { reasonCode: error.reasonCode, message: error.message },
});

const hasUtf8Bom = (bytes: Uint8Array): boolean =>
  bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

const byteWidthFor = (byte: number): number => {
  if (byte <= 0x7f) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  throw new Utf8SourceError('invalid_utf8', 'Structured source contains an invalid UTF-8 leading byte.');
};

export const createUtf8OffsetTable = (text: string, sourceBytes: Uint8Array): Utf8OffsetTable => {
  let decoded: string;
  try {
    decoded = decodeUtf8(sourceBytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new Utf8SourceError('invalid_utf8', 'Structured source bytes are not valid UTF-8.', { cause: error });
  }

  if (decoded !== text) {
    throw new Utf8SourceError(
      'invariant_violation',
      'Structured source text does not match the original UTF-8 bytes.',
    );
  }

  const offsets = new Uint32Array(text.length + 1);
  let textOffset = 0;
  let byteOffset = hasUtf8Bom(sourceBytes) ? 3 : 0;
  offsets[0] = byteOffset;

  while (textOffset < text.length) {
    const codePoint = text.codePointAt(textOffset);
    if (codePoint === undefined) {
      throw new Utf8SourceError('invariant_violation', 'Structured source text has an invalid UTF-16 boundary.');
    }
    const firstByte = sourceBytes[byteOffset];
    if (firstByte === undefined) {
      throw new Utf8SourceError('invariant_violation', 'Structured source bytes ended before the source text.');
    }
    byteOffset += byteWidthFor(firstByte);
    textOffset += codePoint > 0xffff ? 2 : 1;
    if (codePoint > 0xffff) offsets[textOffset - 1] = byteOffset;
    offsets[textOffset] = byteOffset;
  }

  if (byteOffset !== sourceBytes.length) {
    throw new Utf8SourceError('invariant_violation', 'Structured source byte and text lengths do not match.');
  }

  return { byteOffsetAtUtf16: (offset) => offsets[offset] ?? byteOffset };
};
