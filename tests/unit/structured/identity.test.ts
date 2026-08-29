import { describe, expect, it } from "vitest";

import { createGenerationId, createSymbolId } from "../../../src/structured/identity.js";

describe("structured identity", () => {
  const base = {
    filePath: "src/auth.ts",
    qualifiedName: "AuthService.authenticate",
    kind: "method",
    signatureDiscriminator:
      "authenticate ( token : string ) : Promise < User >",
    occurrence: 0,
  } as const;

  it("keeps an ID stable when body and position change", () => {
    const changedPresentation = {
      ...base,
      body: "return await authenticate(token);",
      startLine: 80,
      endLine: 95,
    };

    expect(createSymbolId(base)).toBe(createSymbolId(changedPresentation));
    expect(createSymbolId(base)).toMatch(/^symbol_v1_[A-Za-z0-9_-]{43}$/);
  });

  it("changes generation IDs when parser inputs change", () => {
    const input = {
      schemaVersion: 1 as const,
      parserId: "typescript",
      parserVersion: "1.0.0",
      contentHash: "a".repeat(64),
    };

    expect(createGenerationId(input)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createGenerationId(input)).toBe(createGenerationId({ ...input }));
    expect(createGenerationId(input)).not.toBe(
      createGenerationId({ ...input, contentHash: "b".repeat(64) }),
    );
    expect(createGenerationId(input)).not.toBe(
      createGenerationId({ ...input, parserVersion: "1.0.1" }),
    );
  });

  it("changes IDs for a renamed symbol or changed signature", () => {
    expect(createSymbolId(base)).not.toBe(
      createSymbolId({ ...base, qualifiedName: "AuthService.login" }),
    );
    expect(createSymbolId(base)).not.toBe(
      createSymbolId({
        ...base,
        signatureDiscriminator:
          "authenticate ( token : number ) : Promise < User >",
      }),
    );
  });
});
