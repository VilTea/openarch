import type { CurrentMetricsProjection, StorageService } from "../port/StorageService";

/**
 * Shared read boundary for consumers that describe the current project.
 * Complete-scan consumers must keep using listAllFileMetrics instead; this
 * helper is deliberately the only fallback point for legacy test adapters.
 */
export const currentFileMetrics = (storage: StorageService, projection: CurrentMetricsProjection = "worktree") =>
  storage.listCurrentFileMetrics
    ? storage.listCurrentFileMetrics(projection)
    : storage.listAllFileMetrics();
