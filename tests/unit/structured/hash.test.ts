import { describe, expect, it } from "vitest";

import { decodeUtf8, sha256Hex } from "../../../src/structured/hash.js";

describe("structured byte helpers", () => {
  it("hashes the original bytes without re-encoding logical text", () => {
    const decomposed = Buffer.from("cafe\u0301", "utf8");
    const composed = Buffer.from("café", "utf8");

    expect(decomposed.toString("utf8")).not.toBe(composed.toString("utf8"));
    expect(sha256Hex(decomposed)).not.toBe(sha256Hex(composed));
  });

  it("returns the known SHA-256 digest as lowercase hexadecimal", () => {
    const digest = sha256Hex(new TextEncoder().encode("abc"));

    expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes exact UTF-8 bytes rather than normalized text", () => {
    expect(sha256Hex(Buffer.from("cafe\u0301", "utf8"))).not.toBe(
      sha256Hex(Buffer.from("café", "utf8")),
    );
  });

  it("rejects malformed UTF-8 instead of replacing bytes", () => {
    expect(() => decodeUtf8(new Uint8Array([0xc3, 0x28]))).toThrow();
  });

  it("preserves valid bytes when decoded and encoded again", () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9]);

    expect(new TextEncoder().encode(decodeUtf8(bytes))).toEqual(bytes);
  });
});
