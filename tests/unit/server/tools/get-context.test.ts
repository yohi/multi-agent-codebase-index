import { describe, expect, it } from 'vitest';

import { executeGetContext } from '../../../../src/server/tools/get-context.js';

describe('executeGetContext', () => {
  it('returns the requested line slice from the file content', async () => {
    const sanitizer = {
      sanitize: async (filePath: string) => `/sandbox/${filePath}`,
    };
    const result = await executeGetContext(
      async () => 'line1\nline2\nline3\nline4',
      sanitizer as never,
      {
        filePath: 'src/auth.ts',
        startLine: 2,
        endLine: 3,
      },
    );

    expect(result).toEqual({
      filePath: 'src/auth.ts',
      content: 'line2\nline3',
      startLine: 2,
      endLine: 3,
    });
  });

  it('propagates sanitize errors for missing files', async () => {
    const sanitizer = {
      sanitize: async () => {
        const error = new Error('ENOENT: no such file or directory');
        (error as NodeJS.ErrnoException).code = 'ENOENT';
        throw error;
      },
    };

    await expect(
      executeGetContext(
        async () => 'unused',
        sanitizer as never,
        {
          filePath: 'src/missing.ts',
        },
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws Invalid line range when startLine is greater than endLine', async () => {
    const sanitizer = {
      sanitize: async (filePath: string) => `/sandbox/${filePath}`,
    };

    await expect(
      executeGetContext(
        async () => 'line1\nline2\nline3\nline4',
        sanitizer as never,
        {
          filePath: 'src/auth.ts',
          startLine: 3,
          endLine: 2,
        },
      ),
    ).rejects.toThrow('Invalid line range: startLine (3) is greater than endLine (2)');
  });

  it('throws Invalid line range using clamped values when startLine is out of bounds', async () => {
    const sanitizer = {
      sanitize: async (filePath: string) => `/sandbox/${filePath}`,
    };

    await expect(
      executeGetContext(
        async () => 'line1\nline2\nline3\nline4\nline5',
        sanitizer as never,
        {
          filePath: 'src/auth.ts',
          startLine: 10,
          endLine: 3,
        },
      ),
    ).rejects.toThrow('Invalid line range: startLine (5) is greater than endLine (3)');
  });
});
