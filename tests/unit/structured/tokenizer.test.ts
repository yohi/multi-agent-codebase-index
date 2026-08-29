import { describe, expect, it } from "vitest";

import {
  buildCanonicalContext,
  packRelatedImports,
  tokenCounter,
} from "../../../src/structured/tokenizer.js";

describe("canonical structured context", () => {
  it("joins imports and the complete symbol with exactly one blank line", () => {
    expect(
      buildCanonicalContext(
        ['import { User } from "./user.js";'],
        "export const getUser = () => null;",
      ),
    ).toBe(
      'import { User } from "./user.js";\n\nexport const getUser = () => null;',
    );
  });

  it("keeps a budget-overflowing symbol complete and omits all imports", () => {
    const result = packRelatedImports({
      symbolSource: "very long complete symbol",
      tokenBudget: 1,
      imports: [
        {
          id: "one",
          rawSource: 'import { User } from "./user.js";',
          startByte: 0,
        },
      ],
    });

    expect(result.context).toBe("very long complete symbol");
    expect(result.tokenizer).toBe(tokenCounter.tokenizer);
    expect(result.tokenizerVersion).toBe(tokenCounter.tokenizerVersion);
    expect(result.budget.exceeded).toBe(true);
    expect(result.budget.omittedForBudget).toBe(1);
  });

  it("counts tokens with the pinned local tokenizer", () => {
    expect(tokenCounter.tokenizer).toBe("cl100k_base");
    expect(tokenCounter.tokenizerVersion).toBe("js-tiktoken@1.0.21");
    expect(tokenCounter.count("hello world")).toBe(2);
  });

  it("deduplicates IDs and evaluates later imports after an omitted candidate", () => {
    const result = packRelatedImports({
      symbolSource: "symbol",
      tokenBudget: tokenCounter.count(buildCanonicalContext(["import b from 'b';"], "symbol")),
      imports: [
        { id: "duplicate", rawSource: "import a from 'a'; ".repeat(20), startByte: 0 },
        { id: "duplicate", rawSource: "import a from 'a'; ".repeat(20), startByte: 1 },
        { id: "later", rawSource: "import b from 'b';", startByte: 2 },
      ],
    });

    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]?.id).toBe("later");
    expect(result.budget.omittedForBudget).toBe(1);
  });
});
