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
        mode: 'eager',
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
          mode: 'eager',
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
          mode: 'eager',
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
          mode: 'eager',
          startLine: 10,
          endLine: 3,
        },
      ),
    ).rejects.toThrow('Invalid line range: startLine (5) is greater than endLine (3)');
  });

  describe('deferred mode', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n');
    const hint = 'Call get_context with startLine/endLine to fetch specific ranges.';

    it('returns the first PREVIEW_LINES lines as a preview when mode is deferred and no range is given', async () => {
      const sanitizer = {
        sanitize: async (filePath: string) => `/sandbox/${filePath}`,
      };

      const result = await executeGetContext(
        async () => content,
        sanitizer as never,
        {
          filePath: 'src/big.ts',
          mode: 'deferred',
        },
      );

      expect(result).toEqual({
        filePath: 'src/big.ts',
        mode: 'deferred',
        totalLines: 30,
        summary: Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n'),
        previewStartLine: 1,
        previewEndLine: 20,
        hint,
      });
    });

    it('uses the requested range as the preview window when mode is deferred and a range is given', async () => {
      const sanitizer = {
        sanitize: async (filePath: string) => `/sandbox/${filePath}`,
      };

      const result = await executeGetContext(
        async () => content,
        sanitizer as never,
        {
          filePath: 'src/big.ts',
          mode: 'deferred',
          startLine: 10,
          endLine: 15,
        },
      );

      expect(result).toEqual({
        filePath: 'src/big.ts',
        mode: 'deferred',
        totalLines: 30,
        summary: Array.from({ length: 6 }, (_, i) => `line${i + 10}`).join('\n'),
        previewStartLine: 10,
        previewEndLine: 15,
        hint,
      });
    });

    it('windows PREVIEW_LINES lines forward from startLine, clamped to the file end, when only startLine is given', async () => {
      const sanitizer = {
        sanitize: async (filePath: string) => `/sandbox/${filePath}`,
      };

      const result = await executeGetContext(
        async () => content,
        sanitizer as never,
        {
          filePath: 'src/big.ts',
          mode: 'deferred',
          startLine: 25,
        },
      );

      expect(result).toEqual({
        filePath: 'src/big.ts',
        mode: 'deferred',
        totalLines: 30,
        summary: Array.from({ length: 6 }, (_, i) => `line${i + 25}`).join('\n'),
        previewStartLine: 25,
        previewEndLine: 30,
        hint,
      });
    });

    it('windows PREVIEW_LINES lines backward from endLine, clamped to line 1, when only endLine is given', async () => {
      const sanitizer = {
        sanitize: async (filePath: string) => `/sandbox/${filePath}`,
      };

      const result = await executeGetContext(
        async () => content,
        sanitizer as never,
        {
          filePath: 'src/big.ts',
          mode: 'deferred',
          endLine: 10,
        },
      );

      expect(result).toEqual({
        filePath: 'src/big.ts',
        mode: 'deferred',
        totalLines: 30,
        summary: Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'),
        previewStartLine: 1,
        previewEndLine: 10,
        hint,
      });
    });

    it('propagates sanitize errors for missing files even when mode is deferred', async () => {
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
            mode: 'deferred',
          },
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('omits content/startLine/endLine from the result when mode is deferred', async () => {
      const sanitizer = {
        sanitize: async (filePath: string) => `/sandbox/${filePath}`,
      };

      const result = await executeGetContext(
        async () => content,
        sanitizer as never,
        {
          filePath: 'src/big.ts',
          mode: 'deferred',
        },
      );

      expect(result).not.toHaveProperty('content');
      expect(result).not.toHaveProperty('startLine');
      expect(result).not.toHaveProperty('endLine');
    });

    it('throws Invalid line range using clamped values when mode is deferred and the requested range is reversed after clamping', async () => {
      const sanitizer = {
        sanitize: async (filePath: string) => `/sandbox/${filePath}`,
      };

      await expect(
        executeGetContext(
          async () => 'line1\nline2\nline3\nline4\nline5',
          sanitizer as never,
          {
            filePath: 'src/auth.ts',
            mode: 'deferred',
            startLine: 10,
            endLine: 3,
          },
        ),
      ).rejects.toThrow('Invalid line range: startLine (5) is greater than endLine (3)');
    });
  });
});
