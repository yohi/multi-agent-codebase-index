import { describe, expect, it } from "vitest";

import { createSymbolId } from "../../../src/structured/identity.js";

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
    expect(createSymbolId(base)).toBe(createSymbolId({ ...base }));
    expect(createSymbolId(base)).toMatch(/^symbol_v1_[A-Za-z0-9_-]{43}$/);
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
