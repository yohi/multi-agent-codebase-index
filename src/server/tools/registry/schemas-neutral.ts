/** SDK-neutral tool input schema DSL (design doc §7.1). */
export type NeutralField =
  | { kind: 'string'; optional?: boolean; description?: string }
  | { kind: 'integer'; optional?: boolean; description?: string; maximum?: number }
  | { kind: 'number'; optional?: boolean; description?: string }
  | { kind: 'boolean'; optional?: boolean; description?: string; default?: boolean }
  | { kind: 'stringArray'; optional?: boolean; description?: string }
  | {
      kind: 'enum';
      values: [string, ...string[]];
      optional?: boolean;
      default?: string;
      description?: string;
    };

export type NeutralSchema = Record<string, NeutralField>;
