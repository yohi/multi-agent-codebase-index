# Embedding Configuration

This document is part of the canonical Nexus configuration reference. See [Configuration](../configuration.md) for resolution rules and routing.

## Fields

| Field | Default | Environment variable | Notes |
| --- | --- | --- | --- |
| `embedding.provider` | `ollama` | `NEXUS_EMBEDDING_PROVIDER` | `ollama`, `openai-compat`, `bedrock`, or `test`. |
| `embedding.model` | `nomic-embed-text` | `NEXUS_EMBEDDING_MODEL` | Provider model name. |
| `embedding.dimensions` | `768` | `NEXUS_EMBEDDING_DIMENSIONS` | Expected vector dimensions. |
| `embedding.baseUrl` | `http://127.0.0.1:11434` | `NEXUS_EMBEDDING_BASE_URL` | For HTTP providers. With `openai-compat`, supply the complete endpoint path. If `embedding.apiKey` is set, this URL must use `https:`; HTTP is allowed without an API key. |
| `embedding.apiKey` | unset | `NEXUS_EMBEDDING_API_KEY` | Optional provider API key. |
| `embedding.region` | unset; Bedrock falls back to `us-east-1` | `NEXUS_EMBEDDING_REGION` | AWS region for `bedrock`. |
| `embedding.profile` | unset | `NEXUS_EMBEDDING_PROFILE` | Optional named AWS profile for `bedrock`. |
| `embedding.maxConcurrency` | `1` | `NEXUS_EMBEDDING_MAX_CONCURRENCY` | Maximum concurrent embedding requests. |
| `embedding.batchSize` | `32` | `NEXUS_EMBEDDING_BATCH_SIZE` | Chunks per embedding batch. |
| `embedding.retryCount` | `3` | `NEXUS_EMBEDDING_RETRY_COUNT` | Transient-failure retries. `0` is allowed. |
| `embedding.retryBaseDelayMs` | `250` | `NEXUS_EMBEDDING_RETRY_BASE_DELAY_MS` | Retry backoff base delay. |
| `embedding.timeoutMs` | `120000` | `NEXUS_EMBEDDING_TIMEOUT_MS` | HTTP request timeout. |
| `embedding.ollamaLockTimeoutMs` | `300000` | `NEXUS_OLLAMA_LOCK_TIMEOUT_MS` | Maximum wait for the machine-global Ollama lock. |
| `embedding.ollamaNumThread` | `2` | `NEXUS_OLLAMA_NUM_THREAD` | Integer from `1` through `16`; invalid values fall back to `2`. |

## OpenAI-compatible providers

When `embedding.provider` is `openai-compat`, `embedding.baseUrl` is the complete request endpoint, for example:

```text
https://api.openai.com/v1/embeddings
https://gateway.truefoundry.ai/embeddings
```

Nexus sends the request to that path without rewriting it.

## Bedrock

The `bedrock` provider calls AWS Bedrock Runtime directly. Authentication comes from the normal AWS SDK credential chain. `embedding.profile` selects a named profile when configured.

## CPU-only Ollama guidance

The default `embedding.maxConcurrency=1` is intentionally conservative. For CPU-only Ollama, keep concurrency at `1`; raising it can cause contention, timeouts, and dead-letter growth.

Recommended baseline:

```bash
export NEXUS_EMBEDDING_MAX_CONCURRENCY=1
export NEXUS_OLLAMA_NUM_THREAD=2
```

Typical guidance:
- CPU-only Ollama: concurrency `1`
- GPU around 8 GiB VRAM: `2`-`3`
- GPU 16 GiB+ VRAM: `4`-`8`

Increase gradually and stop before dead-letter/abandoned work begins to grow.
