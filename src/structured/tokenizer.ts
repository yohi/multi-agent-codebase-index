import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';

const encoder = new Tiktoken(cl100kBase);
// js-tiktoken@1.0.21 does not export package.json; keep this synchronized with package.json and package-lock.json.
const jsTiktokenVersion = '1.0.21' as const;

export const tokenCounter = {
  tokenizer: 'cl100k_base' as const,
  tokenizerVersion: `js-tiktoken@${jsTiktokenVersion}` as const,
  count: (text: string): number => encoder.encode(text).length,
};

export const buildCanonicalContext = (imports: readonly string[], symbolSource: string): string => {
  const importText = imports.join('\n');
  return importText.length > 0 ? `${importText}\n\n${symbolSource}` : symbolSource;
};

export interface ImportCandidate {
  readonly id: string;
  readonly rawSource: string;
  readonly startByte: number;
}

export interface PackRelatedImportsInput {
  readonly imports: readonly ImportCandidate[];
  readonly symbolSource: string;
  readonly tokenBudget: number;
}

export interface PackedContext {
  readonly context: string;
  readonly imports: readonly ImportCandidate[];
  readonly tokenizer: typeof tokenCounter.tokenizer;
  readonly tokenizerVersion: typeof tokenCounter.tokenizerVersion;
  readonly budget: {
    readonly exceeded: boolean;
    readonly omittedForBudget: number;
  };
}

export const packRelatedImports = (input: PackRelatedImportsInput): PackedContext => {
  const selected: ImportCandidate[] = [];
  const seen = new Set<string>();
  let omittedForBudget = 0;
  let selectedTokenCount = tokenCounter.count(input.symbolSource);

  for (const candidate of input.imports) {
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    const proposedImports = [...selected.map((item) => item.rawSource), candidate.rawSource];
    const proposedTokenCount = tokenCounter.count(buildCanonicalContext(proposedImports, input.symbolSource));
    if (proposedTokenCount <= input.tokenBudget) {
      selected.push(candidate);
      selectedTokenCount = proposedTokenCount;
    } else {
      omittedForBudget += 1;
    }
  }

  const context = buildCanonicalContext(selected.map((candidate) => candidate.rawSource), input.symbolSource);
  return {
    context,
    imports: selected,
    tokenizer: tokenCounter.tokenizer,
    tokenizerVersion: tokenCounter.tokenizerVersion,
    budget: {
      exceeded: selectedTokenCount > input.tokenBudget,
      omittedForBudget,
    },
  };
};
