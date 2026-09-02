export interface Utf8OffsetTable {
  readonly byteOffsetAtUtf16: (offset: number) => number;
}

const textEncoder = new TextEncoder();

export const createUtf8OffsetTable = (text: string): Utf8OffsetTable => {
  const offsets = new Uint32Array(text.length + 1);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    offsets[index] = bytes;
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) continue;
    const width = textEncoder.encode(String.fromCodePoint(codePoint)).byteLength;
    bytes += width;
    if (codePoint > 0xffff) { index += 1; offsets[index] = bytes; }
  }
  offsets[text.length] = bytes;
  return { byteOffsetAtUtf16: (offset) => offsets[offset] ?? bytes };
};
