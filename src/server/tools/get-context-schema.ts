/** Arguments for get_context, validated by the v1/v2 SDK adapters. */
export interface GetContextToolArgs {
  filePath: string;
  symbolName?: string;
  startLine?: number;
  endLine?: number;
  mode: 'eager' | 'deferred';
}
