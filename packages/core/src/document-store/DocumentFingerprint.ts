import { createHash } from "node:crypto";

export const INDEX_VERSION = "1" as const;
export const MINHASH_SIZE = 64;
export const BAND_SIZE = 8;
export const MINHASH_CANDIDATE = 0.45;
export const SIMHASH_DISTANCE = 16;

export interface IndexedDocument {
  readonly path: string;
  readonly contentSha256: string;
  readonly minHash: readonly number[];
  readonly simHash: string;
  readonly title?: string;
}

const normalize = (text: string): string => text
  .replace(/^---[\s\S]*?---\s*/u, "")
  .replace(/```[\s\S]*?```/gu, " ")
  .replace(/<!--([\s\S]*?)-->/gu, " ")
  .normalize("NFKC")
  .toLocaleLowerCase()
  .replace(/\s+/gu, " ")
  .trim();

const featuresOf = (text: string): readonly string[] => {
  const chars = [...normalize(text)];
  if (chars.length <= 3) return chars.length > 0 ? [chars.join("")] : [];
  return Array.from({ length: chars.length - 2 }, (_, index) => chars.slice(index, index + 3).join(""));
};

export const hash32 = (text: string, seed: number): number => {
  let hash = (2166136261 ^ seed) >>> 0;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
};

const minHashOf = (features: readonly string[]): readonly number[] => Array.from({ length: MINHASH_SIZE }, (_, seed) => {
  let value = 0xffffffff;
  for (const feature of features) value = Math.min(value, hash32(feature, seed * 0x9e3779b1));
  return value === 0xffffffff ? 0 : value;
});

/** 代码级特征指纹（复用 minhash 内核，校准 2026-08-08）：
 *  测试膨胀的样板块相似度检测——行级 shingle（归一化行，去动态片段），
 *  与文档指纹（char 3-gram）同构，可复用 LSH band 候选与 minHash 验证。 */
export const codeFeaturesOf = (content: string, window = 3): readonly string[] => {
  const lines = content.split(/\r?\n/)
    .map((line) => line.trim().replace(/`.+?`/gu, "`X`").replace(/\b\d+\b/g, "N").replace(/\/\/.*$/u, ""))
    .filter((line) => line.length > 4);
  const features: string[] = [];
  for (let index = 0; index + window <= lines.length; index += 1) features.push(lines.slice(index, index + window).join("\n"));
  return features;
};

export const codeIndexedDocument = (path: string, content: string): IndexedDocument => ({
  path,
  contentSha256: contentSha256(content),
  minHash: minHashOf(codeFeaturesOf(content)),
  simHash: simHashOf(codeFeaturesOf(content)),
});

const simHashOf = (features: readonly string[]): string => {
  const weights = Array.from({ length: 64 }, () => 0);
  for (const feature of features) {
    const digest = createHash("sha256").update(feature).digest();
    for (let bit = 0; bit < 64; bit += 1) weights[bit] += (digest[Math.floor(bit / 8)] & (1 << (bit % 8))) !== 0 ? 1 : -1;
  }
  let value = 0n;
  for (let bit = 0; bit < 64; bit += 1) if (weights[bit] >= 0) value |= 1n << BigInt(bit);
  return value.toString(16).padStart(16, "0");
};

export const contentSha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

export const indexedDocument = (path: string, content: string): IndexedDocument => {
  const normalized = normalize(content);
  const features = featuresOf(content);
  const title = normalized.match(/^#\s+([^\n]+)/u)?.[1];
  return { path, contentSha256: contentSha256(content), minHash: minHashOf(features), simHash: simHashOf(features), ...(title ? { title } : {}) };
};

export const minHashSimilarity = (left: readonly number[], right: readonly number[]): number => {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  return left.slice(0, length).filter((value, index) => value === right[index]).length / length;
};

export const simHashDistance = (left: string, right: string): number => {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (value > 0n) {
    distance += Number(value & 1n);
    value >>= 1n;
  }
  return distance;
};

export const bucketKeys = (minHash: readonly number[]): readonly string[] => Array.from({ length: MINHASH_SIZE / BAND_SIZE }, (_, band) =>
  `${band}:${minHash.slice(band * BAND_SIZE, (band + 1) * BAND_SIZE).join(",")}`,
);
