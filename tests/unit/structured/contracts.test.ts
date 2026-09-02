import { describe, expect, it } from "vitest";

import type { StructuredParseResult } from "../../../src/structured/contracts.js";

const degradedResult = {
  status: "degraded",
  retrievability: "partial",
  declarations: [],
  imports: [],
  failure: { reasonCode: "parse_error", message: "partial parse" },
} satisfies StructuredParseResult;

const unsupportedResult = {
  status: "unsupported",
  retrievability: "none",
  declarations: [],
  imports: [],
  failure: { reasonCode: "unsupported_language", message: "unsupported language" },
} satisfies StructuredParseResult;

const failedResult = {
  status: "failed",
  retrievability: "none",
  declarations: [],
  imports: [],
  failure: { reasonCode: "parse_error", message: "parse failed" },
} satisfies StructuredParseResult;

describe("structured parse result contracts", () => {
  it("maps non-exact statuses to their retrievability", () => {
    expect(degradedResult.retrievability).toBe("partial");
    expect(unsupportedResult.retrievability).toBe("none");
    expect(failedResult.retrievability).toBe("none");
  });
});
