import { readMetricsPort } from '../server/metrics-port.js';

export interface IndexProgress {
  readonly active: boolean;
  readonly processedFiles: number;
  readonly totalFiles: number;
}

const METRICS_REQUEST_TIMEOUT_MS = 500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const readMetricValue = (payload: unknown, name: string): number | undefined => {
  if (!isUnknownArray(payload)) {
    return undefined;
  }

  const metric = payload.find((candidate) => isRecord(candidate) && candidate.name === name);
  if (!isRecord(metric) || !isUnknownArray(metric.values)) {
    return undefined;
  }

  const value = metric.values.find((candidate) => isRecord(candidate) && typeof candidate.value === 'number');
  if (!isRecord(value) || typeof value.value !== 'number' || !Number.isFinite(value.value)) {
    return undefined;
  }

  return value.value;
};

export const readIndexProgress = async (storageDir: string): Promise<IndexProgress | undefined> => {
  const port = await readMetricsPort(storageDir);
  if (port === undefined) {
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METRICS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/metrics/json`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }

    const payload: unknown = await response.json();
    const active = readMetricValue(payload, 'nexus_indexing_active');
    const processedFiles = readMetricValue(payload, 'nexus_indexing_processed_files');
    const totalFiles = readMetricValue(payload, 'nexus_indexing_total_files');
    if (active === undefined || processedFiles === undefined || totalFiles === undefined) {
      return undefined;
    }

    return {
      active: active === 1,
      processedFiles,
      totalFiles,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};
