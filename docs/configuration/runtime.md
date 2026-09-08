# Runtime and Bridge Configuration

This document is part of the canonical Nexus configuration reference. See [Configuration](../configuration.md) for resolution rules.

## Project identity and metrics

| Field | Default | Environment variable | Notes |
| --- | --- | --- | --- |
| `projectName` | project root basename | `NEXUS_PROJECT_NAME` | Default Prometheus `project` label and Aggregator `projectId`. The `.nexus.json` value takes precedence over the environment variable. |
| `metricsPort` | OS-assigned | `NEXUS_METRICS_PORT` | Listen port for `/metrics`, `/metrics/json`, and `/health`. |
| `aggregatorPort` | `9470` | `NEXUS_AGGREGATOR_PORT` | Dashboard Aggregator port and heartbeat destination. The `.nexus.json` value takes precedence over the environment variable. |

For `nexus dashboard`, `--aggregator-port` has highest precedence. The normal server has no equivalent CLI option.

## Package mode

`packageMode` / `NEXUS_PACKAGE_MODE` enables distribution-specific constraints.

Accepted environment values are `1`, `true`, `0`, and `false` (case-insensitive). Other values are ignored and fall back to `.nexus.json` or the default `false`.

When package mode is enabled:
- `embedding.provider` is required to be `bedrock`;
- model, dimensions, and region remain deployment-configurable;
- the local metrics HTTP server and `nexus dashboard` remain available;
- automatic heartbeat registration with the Grafana/Prometheus Aggregator is skipped.

## HTTP bridge and managed server

`nexus http-bridge` can discover or start one project-scoped loopback HTTP Nexus process. These are CLI/environment settings, not `.nexus.json` fields.

| CLI option | Environment variable | Default | Purpose |
| --- | --- | --- | --- |
| `--project-root <path>` | `NEXUS_PROJECT_ROOT` | current directory | Project root used by the bridge and Nexus process. |
| `--idle-shutdown-ms <ms>` | `NEXUS_IDLE_SHUTDOWN_MS` | `0` | Delay before a managed server shuts down after active clients reach zero. `0` means immediate shutdown. |

`--managed` and `--port 0 --managed` are hidden child-process options used internally by `nexus http-bridge`; normal users do not need to specify them.
