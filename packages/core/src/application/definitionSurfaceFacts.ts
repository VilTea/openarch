// Definition-surface fact layer (report-only recall).
// Reuses the same minhash + LSH core as test bloat code similarity, but groups
// production files into cross-file structural-similarity candidates. Similarity
// here is a fact, never a violation: contract interpretation lives in
// definitionSurfaceContracts.ts.
import { readFileSync } from "node:fs";
import { bucketKeys, codeIndexedDocument, minHashSimilarity, type IndexedDocument } from "../document-store/DocumentFingerprint";
import { normalizeRepositoryPath } from "../script-runtime/projectFacts";

export interface DefinitionSurfaceSimilarityBlock {
  readonly file: string;
  readonly startLine: number;
  readonly text: string;
}

export interface DefinitionSurfaceSimilarityGroup {
  readonly id: string;
  readonly files: readonly string[];
  readonly repeatedBlockLines: number;
  readonly maxSimilarity: number;
  readonly sampleBlocks: readonly DefinitionSurfaceSimilarityBlock[];
}

export interface DefinitionSurfaceSimilarityOptions {
  readonly blockWindow?: number;
  readonly step?: number;
  readonly threshold?: number;
  readonly maxGroups?: number;
  readonly projectRoot?: string;
}

const lineCount = (text: string): number => (text.match(/\r?\n/g)?.length ?? 0) + 1;

/** Groups files whose block-level minhash similarity exceeds the threshold.
 *  Returns only groups with at least two files. All paths are normalized to
 *  repository-relative POSIX paths in the result. */
export const definitionSurfaceSimilarityGroups = (
  files: readonly string[],
  options: DefinitionSurfaceSimilarityOptions = {},
): readonly DefinitionSurfaceSimilarityGroup[] => {
  const blockWindow = options.blockWindow ?? 12;
  const step = options.step ?? Math.max(1, Math.floor(blockWindow / 2));
  const threshold = options.threshold ?? 0.6;
  const maxGroups = options.maxGroups ?? 10;
  const projectRoot = options.projectRoot;

  const candidates = [...new Set(files)].filter(Boolean).sort();
  if (candidates.length < 2) return [];

  const blockDocs = new Map<string, IndexedDocument>();
  const blockLines = new Map<string, number>();
  const blockFile = new Map<string, string>();
  const blockStart = new Map<string, number>();
  const blockText = new Map<string, string>();
  for (const file of candidates) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let start = 0; start + blockWindow <= lines.length; start += step) {
      const value = lines.slice(start, start + blockWindow).join("\n");
      const key = `${file}#${start}`;
      blockDocs.set(key, codeIndexedDocument(key, value));
      blockLines.set(key, lines.slice(start, start + blockWindow).filter((line) => line.trim().length > 0).length);
      blockFile.set(key, file);
      blockStart.set(key, start + 1);
      blockText.set(key, value);
    }
  }
  if (blockDocs.size === 0) return [];

  const buckets = new Map<string, string[]>();
  for (const [key, doc] of blockDocs) {
    for (const bucket of bucketKeys(doc.minHash)) buckets.set(bucket, [...(buckets.get(bucket) ?? []), key]);
  }

  const parent = new Map<string, string>();
  const find = (file: string): string => {
    const root = parent.get(file) ?? file;
    if (root !== file) {
      const next = find(root);
      parent.set(file, next);
      return next;
    }
    return file;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
  };

  const repeatedBlocks = new Set<string>();
  const pairSimilarity = new Map<string, number>();
  const seen = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const pair = [bucket[i]!, bucket[j]!].sort().join("\u0000");
        if (seen.has(pair)) continue;
        seen.add(pair);
        const leftDoc = blockDocs.get(bucket[i]!)!;
        const rightDoc = blockDocs.get(bucket[j]!)!;
        const similarity = minHashSimilarity(leftDoc.minHash, rightDoc.minHash);
        if (similarity < threshold) continue;
        const leftFile = blockFile.get(bucket[i]!)!;
        const rightFile = blockFile.get(bucket[j]!)!;
        union(leftFile, rightFile);
        repeatedBlocks.add(bucket[i]!);
        repeatedBlocks.add(bucket[j]!);
        const filePair = [leftFile, rightFile].sort().join("\u0000");
        pairSimilarity.set(filePair, Math.max(pairSimilarity.get(filePair) ?? 0, similarity));
      }
    }
  }

  const filesByRoot = new Map<string, Set<string>>();
  for (const file of candidates) {
    const root = find(file);
    const existing = filesByRoot.get(root);
    if (existing) existing.add(file);
    else filesByRoot.set(root, new Set([file]));
  }

  const groups: DefinitionSurfaceSimilarityGroup[] = [];
  for (const [root, fileSet] of filesByRoot) {
    if (fileSet.size < 2) continue;
    const filesArr = [...fileSet].sort();
    const fileSetForGroup = new Set(filesArr);
    let repeatedBlockLines = 0;
    for (const key of repeatedBlocks) {
      const file = blockFile.get(key)!;
      if (!fileSetForGroup.has(file)) continue;
      repeatedBlockLines += blockLines.get(key) ?? 0;
    }
    let maxSimilarity = 0;
    for (const [pair, similarity] of pairSimilarity) {
      const [left, right] = pair.split("\u0000");
      if (fileSetForGroup.has(left!) && fileSetForGroup.has(right!)) maxSimilarity = Math.max(maxSimilarity, similarity);
    }
    const sampleBlocks: DefinitionSurfaceSimilarityBlock[] = [];
    for (const key of repeatedBlocks) {
      const file = blockFile.get(key)!;
      if (!fileSetForGroup.has(file) || sampleBlocks.length >= 3) continue;
      sampleBlocks.push({
        file: normalizeRepositoryPath(file, projectRoot),
        startLine: blockStart.get(key) ?? 1,
        text: (blockText.get(key) ?? "").split("\n").slice(0, 2).join("\n"),
      });
    }
    groups.push({
      id: `definition-surface-${groups.length + 1}`,
      files: filesArr.map((file) => normalizeRepositoryPath(file, projectRoot)),
      repeatedBlockLines,
      maxSimilarity,
      sampleBlocks,
    });
  }

  return groups
    .sort((left, right) => right.repeatedBlockLines - left.repeatedBlockLines || right.maxSimilarity - left.maxSimilarity)
    .slice(0, maxGroups);
};

/** Convenience metric for a group's total definition-surface line count. */
export const definitionSurfaceGroupLineCount = (group: DefinitionSurfaceSimilarityGroup): number =>
  group.repeatedBlockLines + group.sampleBlocks.reduce((sum, block) => sum + lineCount(block.text), 0);
