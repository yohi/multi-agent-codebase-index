import { describe, expect, it } from 'vitest';
import { resolveLineRange, sliceContent } from '../../../../src/server/tools/context-helpers.js';

describe('context-helpers', () => {
  describe('resolveLineRange', () => {
    it('resolves valid ranges', () => {
      expect(resolveLineRange(100, 2, 5)).toEqual({ startLine: 2, endLine: 5 });
    });
    it('clamps out of bounds ranges', () => {
      expect(resolveLineRange(5, 1, 20)).toEqual({ startLine: 1, endLine: 5 });
    });
    it('returns null for reversed ranges', () => {
      expect(resolveLineRange(5, 3, 2)).toBeNull();
    });
  });

  describe('sliceContent', () => {
    it('extracts correct lines', () => {
      const content = 'l1\nl2\nl3';
      expect(sliceContent(content, { startLine: 2, endLine: 2 })).toBe('l2');
    });
  });
});
