import type { PathSanitizer } from '../path-sanitizer.js';
import { resolveLineRange, sliceContent, type LineRange } from './context-helpers.js';
import type { GetContextToolArgs } from './get-context-schema.js';

const PREVIEW_LINES = 20;
const DEFERRED_HINT = 'Call get_context with startLine/endLine to fetch specific ranges.';

export interface GetContextEagerResult {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface GetContextDeferredResult {
  filePath: string;
  mode: 'deferred';
  totalLines: number;
  summary: string;
  previewStartLine: number;
  previewEndLine: number;
  hint: string;
}

export type GetContextResult = GetContextEagerResult | GetContextDeferredResult;

const buildInvalidRangeError = (
  totalLines: number,
  startLine: number | undefined,
  endLine: number | undefined,
): Error => {
  const clampedStart = Math.max(1, Math.min(startLine ?? 1, totalLines));
  const clampedEnd = Math.max(1, Math.min(endLine ?? totalLines, totalLines));
  return new Error(`Invalid line range: startLine (${clampedStart}) is greater than endLine (${clampedEnd})`);
};

/**
 * Computes the preview window for deferred mode.
 *
 * - Both startLine and endLine given: the requested range, clamped to file boundaries.
 * - Only startLine given: startLine through startLine + PREVIEW_LINES - 1 (clamped).
 * - Only endLine given: endLine - PREVIEW_LINES + 1 through endLine (clamped).
 * - Neither given: the first PREVIEW_LINES lines of the file.
 */
const resolveDeferredPreviewRange = (
  totalLines: number,
  startLine: number | undefined,
  endLine: number | undefined,
): LineRange => {
  if (startLine !== undefined && endLine !== undefined) {
    const range = resolveLineRange(totalLines, startLine, endLine);
    if (range === null) {
      throw buildInvalidRangeError(totalLines, startLine, endLine);
    }
    return range;
  }

  if (startLine !== undefined) {
    const clampedStart = Math.max(1, Math.min(startLine, totalLines));
    return { startLine: clampedStart, endLine: Math.min(clampedStart + PREVIEW_LINES - 1, totalLines) };
  }

  if (endLine !== undefined) {
    const clampedEnd = Math.max(1, Math.min(endLine, totalLines));
    return { startLine: Math.max(1, clampedEnd - PREVIEW_LINES + 1), endLine: clampedEnd };
  }

  return { startLine: 1, endLine: Math.min(PREVIEW_LINES, totalLines) };
};

export const executeGetContext = async (
  loadFileContent: (filePath: string) => Promise<string>,
  sanitizer: PathSanitizer,
  args: GetContextToolArgs,
): Promise<GetContextResult> => {
  const sanitizedPath = await sanitizer.sanitize(args.filePath);
  const content = await loadFileContent(sanitizedPath);
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (args.mode === 'deferred') {
    const previewRange = resolveDeferredPreviewRange(totalLines, args.startLine, args.endLine);

    return {
      filePath: args.filePath,
      mode: 'deferred',
      totalLines,
      summary: sliceContent(content, previewRange),
      previewStartLine: previewRange.startLine,
      previewEndLine: previewRange.endLine,
      hint: DEFERRED_HINT,
    };
  }

  const range = resolveLineRange(totalLines, args.startLine, args.endLine);

  if (range === null) {
    throw buildInvalidRangeError(totalLines, args.startLine, args.endLine);
  }

  return {
    filePath: args.filePath,
    content: sliceContent(content, range),
    startLine: range.startLine,
    endLine: range.endLine,
  };
};
