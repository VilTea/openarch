/**
 * Compatibility policy for a versioned value that survives an in-memory run.
 * A boundary is only needed when a value crosses time through durable storage.
 */
export interface PersistedVersionBoundary<Version extends string | number> {
  readonly classification: "persisted";
  readonly storage: string;
  readonly version: Version;
  readonly unknownVersion: "reject";
  readonly missingVersion: "reject" | "legacy-supported";
}

export const supportsPersistedVersion = <Version extends string | number>(
  boundary: PersistedVersionBoundary<Version>,
  value: unknown,
): value is Version => value === boundary.version;
