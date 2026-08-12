/** Error codes exposed as structuredContent.error.code on the v2 HTTP path. */
export type NexusErrorCode =
  | 'NEXUS_STORAGE_UNAVAILABLE'
  | 'NEXUS_VECTOR_DIMENSION_MISMATCH'
  | 'NEXUS_CONTENT_NOT_FOUND'
  | 'NEXUS_INDEXING_IN_PROGRESS'
  | 'NEXUS_AUTH_REQUIRED'
  | 'NEXUS_ACCESS_DENIED'
  | 'NEXUS_WORKSPACE_NOT_FOUND'
  | 'NEXUS_REVISION_NOT_READY'
  | 'NEXUS_SYNC_OUT_OF_ORDER'
  | 'NEXUS_SYNC_RECONCILE_REQUIRED'
  | 'NEXUS_RATE_LIMITED';

/** Classify a sanitized error message without exposing implementation details. */
export const classifyErrorMessage = (message: string): NexusErrorCode | undefined => {
  if (message.startsWith('Invalid line range:')) {
    return 'NEXUS_CONTENT_NOT_FOUND';
  }
  if (message === 'already_running' || message.includes('Reindex already running')) {
    return 'NEXUS_INDEXING_IN_PROGRESS';
  }
  const lower = message.toLowerCase();
  if (lower.includes('dimension')) {
    return 'NEXUS_VECTOR_DIMENSION_MISMATCH';
  }
  if (lower.includes('enoent') || lower.includes('no such file')) {
    return 'NEXUS_CONTENT_NOT_FOUND';
  }
  return undefined;
};
