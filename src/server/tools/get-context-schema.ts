import { z } from 'zod';

export const getContextInputSchema = z.object({
  filePath: z.string(),
  /**
   * @deprecated reserved for future use
   */
  symbolName: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  mode: z
    .enum(['eager', 'deferred'])
    .optional()
    .default('eager')
    .describe(
      'Set to "deferred" to receive a short preview and hint instead of full content for large files.',
    ),
});

export type GetContextToolArgs = z.infer<typeof getContextInputSchema>;
