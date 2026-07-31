export interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * Clamps line numbers to valid range [1, totalLines].
 * Returns clamped values without validation of startLine > endLine.
 */
export const clampLineRange = (
  totalLines: number,
  startLine?: number,
  endLine?: number,
): LineRange => {
  const clampedStart = Math.max(1, Math.min(startLine ?? 1, totalLines));
  const clampedEnd = Math.max(1, Math.min(endLine ?? totalLines, totalLines));
  return { startLine: clampedStart, endLine: clampedEnd };
}

export const resolveLineRange = (
  totalLines: number,
  startLine?: number,
  endLine?: number,
): LineRange | null => {
  const clamped = clampLineRange(totalLines, startLine, endLine);

  if (clamped.startLine > clamped.endLine) {
    return null;
  }

  return clamped;
}

export const sliceContent = (content: string, range: LineRange): string => {
  const lines = content.split('\n');
  return lines.slice(range.startLine - 1, range.endLine).join('\n');
};
