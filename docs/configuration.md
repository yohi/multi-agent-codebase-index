# Configuration

This document is the canonical entry point for Nexus runtime configuration. Nexus reads project configuration from `<projectRoot>/.nexus.json`.

## Resolution order

For most settings:

1. environment variable;
2. `.nexus.json`;
3. built-in default.

`projectName` and `aggregatorPort` intentionally prefer the project file:

1. `.nexus.json`;
2. environment variable;
3. built-in default.

For `nexus dashboard`, `--aggregator-port` has the highest precedence.

Empty strings are ignored. Numeric environment variables must be base-10 integers. Unsupported `embedding.provider` values are ignored and fall back to the project-file value or default.

## Reference

- [Storage, watcher, and indexing](configuration/storage-and-indexing.md)
- [Embedding providers and performance](configuration/embedding.md)
- [Runtime, metrics, package mode, and HTTP bridge](configuration/runtime.md)

## Example

```json
{
  "projectName": "my-project",
  "aggregatorPort": 9470,
  "storage": {
    "rootDir": ".nexus",
    "metadataDbPath": ".nexus/metadata.db",
    "vectorDbPath": ".nexus/vectors"
  },
  "watcher": {
    "debounceMs": 100,
    "maxQueueSize": 10000,
    "fullScanThreshold": 5000
  },
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "dimensions": 768,
    "baseUrl": "http://127.0.0.1:11434",
    "maxConcurrency": 1,
    "batchSize": 32,
    "retryCount": 3,
    "retryBaseDelayMs": 250,
    "timeoutMs": 120000,
    "ollamaNumThread": 2
  }
}
```

Keep secrets out of committed configuration. Provider credentials should come from the normal environment/credential mechanism for the selected provider.
