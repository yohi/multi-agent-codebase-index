import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { TOOL_DEFINITIONS } from '../definitions.js';
import type { NeutralField, NeutralSchema } from '../schemas-neutral.js';
import type { ToolHandler } from '../../types.js';

const toZodV3Field = (field: NeutralField): z.ZodTypeAny => {
  switch (field.kind) {
    case 'string':
      return z.string();
    case 'integer':
      return z.number().int().positive();
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

export const toZodV3Shape = (schema: NeutralSchema): z.ZodRawShape => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(schema)) {
    let zodField = toZodV3Field(field);
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
  return shape;
};

export const registerV1Tools = (
  server: McpServer,
  handlers: Record<string, ToolHandler>,
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
        inputSchema: toZodV3Shape(definition.input),
      },
      handler,
    );
  }
};
