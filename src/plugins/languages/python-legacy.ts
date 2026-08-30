import type { FileToChunk, ParsedDeclaration, ParsedSourceFile, SymbolKind } from '../../types/index.js';

const fallbackEnd = (lines: readonly string[], start: number, indent: number): number => {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() && line.search(/\S/u) <= indent) return index - 1;
  }
  return lines.length - 1;
};

export const fixedLineFallback = (file: FileToChunk): ParsedSourceFile => {
  const lines = file.content.split('\n');
  const declarations: ParsedDeclaration[] = [];
  const imports = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^(?:from|import)\s/u.test(line));
  if (imports.length > 0) {
    const first = imports[0];
    const last = imports.at(-1);
    if (first && last) declarations.push({ type: 'import', name: 'imports', startLine: first.index + 1, endLine: last.index + 1, content: lines.slice(first.index, last.index + 1).join('\n').trim() });
  }
  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)(?:async\s+)?(class|def)\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(line);
    if (!match) continue;
    const indent = match[1]?.length ?? 0;
    const name = match[3];
    if (!name || (indent > 0 && match[2] === 'class')) continue;
    const end = fallbackEnd(lines, index, indent);
    const type: SymbolKind = match[2] === 'class' ? 'class' : indent === 0 ? 'function' : 'method';
    declarations.push({ type, name, startLine: index + 1, endLine: end + 1, content: lines.slice(index, end + 1).join('\n').trim() });
  }
  return { rootType: 'module', declarations: declarations.sort((left, right) => left.startLine - right.startLine) };
};
