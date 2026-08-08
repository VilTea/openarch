import { existsSync } from "node:fs";
import { Effect } from "effect";
import { toAbsolute } from "../infra/paths";
import { StorageService } from "../port/StorageService";

export const orphanedBaselinePaths = (
  entries: readonly (readonly [string, unknown])[],
  sourceExists: (path: string) => boolean = (path) => existsSync(toAbsolute(path)),
): readonly string[] => entries.map(([path]) => path).filter((path) => !sourceExists(path));

/** Reports persisted metrics whose source file no longer exists in the working tree.
 *
 * Canonical shards belong to an immutable generation. Removing one shard in
 * place would make its index lie about the generation, so cleanup is deferred
 * to a complete scan publication.
 */
export const reconcileBaseline = () =>
  Effect.gen(function* () {
    const storage = yield* StorageService;
    const stale = orphanedBaselinePaths(yield* storage.listAllFileMetrics());
    return { removed: [] as readonly string[], stale };
  });
