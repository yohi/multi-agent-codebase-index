import { describe, expect, it } from 'vitest';

import { createUtf8OffsetTable } from '../../../src/structured/utf8-offsets.js';

describe('UTF-8 offset table', () => {
  it('uses the original byte sequence when the decoded text follows a BOM', () => {
    const text = '日本語 🦊';
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(text),
    ]);
    const offsets = createUtf8OffsetTable(text, bytes);

    expect(offsets.byteOffsetAtUtf16(0)).toBe(3);
    expect(offsets.byteOffsetAtUtf16(text.length)).toBe(bytes.length);
  });

  it('maps a UTF-16 position inside a surrogate pair to the code point boundary', () => {
    const text = 'a🦊b';
    const bytes = new TextEncoder().encode(text);
    const offsets = createUtf8OffsetTable(text, bytes);

    expect(offsets.byteOffsetAtUtf16(2)).toBe(Buffer.byteLength('a🦊', 'utf8'));
  });

  it('rejects text that does not decode from the original bytes', () => {
    const text = 'package main\n\nfunc Exported() {}';
    const bytes = new TextEncoder().encode(text.replace('Exported', 'Other'));
    let caught: unknown;

    try {
      createUtf8OffsetTable(text, bytes);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ reasonCode: 'invariant_violation' });
  });

  it('classifies invalid original bytes as invalid_utf8', () => {
    const text = 'package main';
    const validBytes = new TextEncoder().encode(text);
    const bytes = new Uint8Array([...validBytes, 0xc3, 0x28]);
    let caught: unknown;

    try {
      createUtf8OffsetTable(text, bytes);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ reasonCode: 'invalid_utf8' });
  });
});
