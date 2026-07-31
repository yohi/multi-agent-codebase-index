export interface LineRange {
  startLine: number;
  endLine: number;
}

export const resolveLineRange = (
  totalLines: number,
  startLine?: number,
  endLine?: number,
): LineRange | null => {
  const resolvedStart = Math.max(1, Math.min(startLine ?? 1, totalLines));
  const resolvedEnd = Math.max(1, Math.min(endLine ?? totalLines, totalLines));

  if (resolvedStart > resolvedEnd) {
    return null;
  }

  return { startLine: resolvedStart, endLine: resolvedEnd };
};

export const sliceContent = (content: string, range: LineRange): string => {
  const lines = content.split('\n');
  return lines.slice(range.startLine - 1, range.endLine).join('\n');
};
