import { createHash } from 'node:crypto';

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export const decodeUtf8 = (bytes: Uint8Array): string => utf8Decoder.decode(bytes);
