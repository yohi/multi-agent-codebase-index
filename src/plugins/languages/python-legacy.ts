import type { FileToChunk, ParsedDeclaration, ParsedSourceFile, SymbolKind } from '../../types/index.js';

type QuoteDelimiter = "'" | '"' | "'''" | '"""';

interface LexicalState {
  readonly quote: QuoteDelimiter | undefined;
  readonly bracketDepth: number;
}

interface ScanResult {
  readonly state: LexicalState;
  readonly hasTopLevelColon: boolean;
}

interface FallbackEndInput {
  readonly lines: readonly string[];
  readonly start: number;
  readonly indent: number;
  readonly states: readonly LexicalState[];
}

const initialLexicalState: LexicalState = { quote: undefined, bracketDepth: 0 };

const scanPythonLine = (line: string, initial: LexicalState): ScanResult => {
  let quote = initial.quote;
  let bracketDepth = initial.bracketDepth;
  let hasTopLevelColon = false;

  for (let index = 0; index < line.length;) {
    const character = line[index];
    if (character === undefined) break;

    if (quote !== undefined) {
      if (line.startsWith(quote, index)) {
        index += quote.length;
        quote = undefined;
      } else if (character === '\\') {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (character === '#') break;
    if (character === '\\') {
      index += 2;
      continue;
    }

    if (character === '"' || character === "'") {
      const triple = character === '"' ? '"""' : "'''";
      if (line.startsWith(triple, index)) {
        quote = triple;
        index += 3;
      } else {
        quote = character;
        index += 1;
      }
      continue;
    }

    if (character === '(' || character === '[' || character === '{') {
      bracketDepth += 1;
    } else if (character === ')' || character === ']' || character === '}') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (character === ':' && bracketDepth === 0) {
      hasTopLevelColon = true;
    }
    index += 1;
  }

  return { state: { quote, bracketDepth }, hasTopLevelColon };
};

const lexicalStatesBefore = (lines: readonly string[]): readonly LexicalState[] => {
  const states: LexicalState[] = [];
  let state = initialLexicalState;
  for (const line of lines) {
    states.push(state);
    state = scanPythonLine(line, state).state;
  }
  return states;
};

const fallbackEnd = ({ lines, start, indent, states }: FallbackEndInput): number => {
  let lastNonEmpty = start;
  let headerComplete = false;
  let state = initialLexicalState;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const nonEmpty = line.trim() !== '';
    const headerWasIncomplete = !headerComplete;
    const scan = scanPythonLine(line, state);
    state = scan.state;
    headerComplete ||= scan.hasTopLevelColon;

    if (index > start && headerWasIncomplete) {
      if (nonEmpty) lastNonEmpty = index;
      continue;
    }

    const insideTripleQuotedString = states[index]?.quote === "'''" || states[index]?.quote === '"""';
    if (index > start && !insideTripleQuotedString && nonEmpty && line.search(/\S/u) <= indent) {
      return lastNonEmpty;
    }
    if (nonEmpty) lastNonEmpty = index;
  }

  return lastNonEmpty;
};

export const fixedLineFallback = (file: FileToChunk): ParsedSourceFile => {
  const lines = file.content.split('\n');
  const states = lexicalStatesBefore(lines);
  const declarations: ParsedDeclaration[] = [];
  const imports = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^(?:from|import)\s/u.test(line));
  if (imports.length > 0) {
    const first = imports[0];
    const last = imports.at(-1);
    if (first && last) declarations.push({ type: 'import', name: 'imports', startLine: first.index + 1, endLine: last.index + 1, content: lines.slice(first.index, last.index + 1).join('\n').trim() });
  }
  for (const [index, line] of lines.entries()) {
    if (states[index]?.quote !== undefined) continue;
    const match = /^(\s*)(?:async\s+)?(class|def)\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(line);
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    const name = match[3];
    if (!name || (indent > 0 && match[2] === 'class')) continue;
    const end = fallbackEnd({ lines, start: index, indent, states });
    let type: SymbolKind;
    if (match[2] === 'class') {
      type = 'class';
    } else if (indent === 0) {
      type = 'function';
    } else {
      type = 'method';
    }
    declarations.push({ type, name, startLine: index + 1, endLine: end + 1, content: lines.slice(index, end + 1).join('\n').trim() });
  }
  return {
    rootType: 'module',
    declarations: declarations.toSorted((left, right) => left.startLine - right.startLine),
  };
};
