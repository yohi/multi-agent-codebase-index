import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod-v4';

import { classifyErrorMessage } from '../../../errors.js';
import { TOOL_DEFINITIONS } from '../definitions.js';
import type { NeutralField, NeutralSchema } from '../schemas-neutral.js';
import type { NexusToolCallResult, ToolHandler } from '../../types.js';

export interface V2ToolLimits {
  topK: number;
  maxResults: number;
}

const DEFAULT_V2_TOOL_LIMITS: V2ToolLimits = { topK: 100, maxResults: 1000 };

const limitFor = (fieldName: string, declaredMaximum: number, limits: V2ToolLimits): number => {
  if (fieldName === 'topK') return limits.topK;
  if (fieldName === 'maxResults') return limits.maxResults;
  return declaredMaximum;
};

const toZodV4Field = (name: string, field: NeutralField, limits: V2ToolLimits): z.ZodType => {
  switch (field.kind) {
    case 'string':
      return z.string();
    case 'integer': {
      let integer = z.number().int().positive();
      if (field.maximum !== undefined) {
        integer = integer.max(limitFor(name, field.maximum, limits));
      }
      return integer;
    }
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'stringArray':
      return z.array(z.string());
    case 'enum':
      return z.enum(field.values);
  }
};

export const toZodV4Object = (
  schema: NeutralSchema,
  limits: V2ToolLimits = DEFAULT_V2_TOOL_LIMITS,
) => {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema)) {
    let zodField = toZodV4Field(key, field, limits);
    if (field.optional === true) {
      zodField = zodField.optional();
    }
    if ('default' in field && field.default !== undefined) {
      zodField = zodField.default(field.default);
    }
    if (field.description !== undefined) {
      zodField = zodField.describe(field.description);
    }
    shape[key] = zodField;
  }
  return z.object(shape);
};

export const withErrorCode = (result: NexusToolCallResult): NexusToolCallResult => {
  if (result.isError !== true || result.structuredContent === undefined) {
    return result;
  }
  const message = result.structuredContent['message'];
  const code = typeof message === 'string' ? classifyErrorMessage(message) : undefined;
  return code === undefined
    ? result
    : { ...result, structuredContent: { ...result.structuredContent, code } };
};

export const registerV2Tools = (
  server: McpServer,
  handlers: Record<string, ToolHandler>,
  limits: V2ToolLimits = DEFAULT_V2_TOOL_LIMITS,
): void => {
  for (const definition of TOOL_DEFINITIONS) {
    const handler = handlers[definition.name];
    if (handler === undefined) {
      throw new Error(`missing handler for tool: ${definition.name}`);
    }
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: toZodV4Object(definition.input, limits),
      },
      async (args, extra) => withErrorCode(await handler(args, { signal: extra.mcpReq.signal })),
    );
  }
};
