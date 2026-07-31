import type { PathSanitizer } from '../path-sanitizer.js';
import { resolveLineRange, sliceContent } from './context-helpers.js';

export interface GetContextToolArgs {
  filePath: string;
  /**
   * @deprecated reserved for future use
   */
  symbolName?: string;
  startLine?: number;
  endLine?: number;
}

export interface GetContextResult {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
}

export const executeGetContext = async (
  loadFileContent: (filePath: string) => Promise<string>,
  sanitizer: PathSanitizer,
  args: GetContextToolArgs,
): Promise<GetContextResult> => {
  const sanitizedPath = await sanitizer.sanitize(args.filePath);
  const content = await loadFileContent(sanitizedPath);
  const lines = content.split('\n');

  const range = resolveLineRange(lines.length, args.startLine, args.endLine);

  if (range === null) {
    const startLine = Math.max(1, Math.min(args.startLine ?? 1, lines.length));
    const endLine = Math.max(1, Math.min(args.endLine ?? lines.length, lines.length));
    throw new Error(`Invalid line range: startLine (${startLine}) is greater than endLine (${endLine})`);
  }

  const slice = sliceContent(content, range);

  return {
    filePath: args.filePath,
    content: slice,
    startLine: range.startLine,
    endLine: range.endLine,
  };
};
