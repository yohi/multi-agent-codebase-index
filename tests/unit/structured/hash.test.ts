import { describe, expect, it } from "vitest";

import { decodeUtf8, sha256Hex } from "../../../src/structured/hash.js";

describe("structured byte helpers", () => {
  it("hashes exact UTF-8 bytes rather than normalized text", () => {
    expect(sha256Hex(Buffer.from("cafe\u0301", "utf8"))).not.toBe(
      sha256Hex(Buffer.from("café", "utf8")),
    );
  });

  it("rejects malformed UTF-8 instead of replacing bytes", () => {
    expect(() => decodeUtf8(new Uint8Array([0xc3, 0x28]))).toThrow();
  });
});
