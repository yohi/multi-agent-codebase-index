/**
 * Content-addressed blob storage for file contents.
 *
 * Each instance is scoped to a single workspace/revision pair via
 * {@link IContentStoreFactory.getStore}. The hash-based methods (put, get,
 * delete, exists) operate on globally unique content hashes. The path-based
 * method (readRange) resolves `path` to a hash through the scoped metadata
 * store and returns the requested line range.
 */
export interface IContentStore {
  /**
   * Persist content bytes keyed by its content hash.
   */
  put(contentHash: string, content: Uint8Array): Promise<void>;

  /**
   * Retrieve content bytes by content hash, or null if absent.
   */
  get(contentHash: string): Promise<Uint8Array | null>;

  /**
   * Remove content bytes by content hash.
   */
  delete(contentHash: string): Promise<void>;

  /**
   * Return true if content bytes for the hash exist.
   */
  exists(contentHash: string): Promise<boolean>;

  /**
   * Resolve `path` within the bound workspace/revision to a content hash,
   * retrieve the bytes, and return the requested inclusive line range as a
   * string.
   */
  readRange(path: string, startLine: number, endLine: number): Promise<string>;
}

/**
 * Factory for workspace/revision-scoped {@link IContentStore} instances.
 */
export interface IContentStoreFactory {
  /**
   * Return a ContentStore bound to the given workspace and revision.
   */
  getStore(workspaceId: string, revisionId: string): IContentStore;
}
