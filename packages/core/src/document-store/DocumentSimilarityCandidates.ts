import { bucketKeys, minHashSimilarity, simHashDistance, MINHASH_CANDIDATE, SIMHASH_DISTANCE, type IndexedDocument } from "./DocumentFingerprint";

export interface DocumentSimilarityCandidate {
  readonly left: string;
  readonly right: string;
  readonly minHashSimilarity: number;
  readonly simHashDistance: number;
  readonly scopeId: string;
}

const candidateFor = (left: IndexedDocument, right: IndexedDocument, scopeId: string): DocumentSimilarityCandidate | undefined => {
  const minHashSimilarityValue = minHashSimilarity(left.minHash, right.minHash);
  const simHashDistanceValue = simHashDistance(left.simHash, right.simHash);
  return minHashSimilarityValue >= MINHASH_CANDIDATE || simHashDistanceValue <= SIMHASH_DISTANCE
    ? { left: left.path, right: right.path, minHashSimilarity: minHashSimilarityValue, simHashDistance: simHashDistanceValue, scopeId }
    : undefined;
};

/** Finds same-scope near duplicates from the index fact, without touching files or observations. */
export const findDocumentSimilarityCandidates = (
  entries: ReadonlyMap<string, IndexedDocument>,
  changed: ReadonlySet<string>,
  scopeId: string,
): readonly DocumentSimilarityCandidate[] => {
  const buckets = new Map<string, string[]>();
  for (const entry of entries.values()) for (const bucket of bucketKeys(entry.minHash)) buckets.set(bucket, [...(buckets.get(bucket) ?? []), entry.path]);
  const candidates: DocumentSimilarityCandidate[] = [];
  const seen = new Set<string>();
  for (const path of changed) {
    const left = entries.get(path);
    if (!left) continue;
    const matches = new Set(bucketKeys(left.minHash).flatMap((bucket) => buckets.get(bucket) ?? []));
    for (const otherPath of matches) {
      if (otherPath === path) continue;
      const pair = [path, otherPath].sort().join("\u0000");
      if (seen.has(pair)) continue;
      seen.add(pair);
      const candidate = candidateFor(left, entries.get(otherPath)!, scopeId);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => right.minHashSimilarity - left.minHashSimilarity || left.simHashDistance - right.simHashDistance);
};
