import { Effect } from "effect";
import { bucketKeys, codeIndexedDocument, hash32, minHashSimilarity, type IndexedDocument } from "../document-store/DocumentFingerprint";
import type { ParserService } from "../port/ParserService";

const FIXTURE_PATTERN = "(call_expression function: (identifier) @fn (#match? @fn \"^(mkdirSync|writeFileSync|rmSync|mkdtempSync|mkdtemp)$\")) @call";
const GIT_PATTERN = "(call_expression function: (identifier) @fn (#eq? @fn \"git\")) @call";

const lineCount = (text: string): number => (text.match(/\r?\n/g)?.length ?? 0) + 1;

/** 模式可测性（缺陷修复 2026-09-25）：FIXTURE_PATTERN/GIT_PATTERN 是 TypeScript/JavaScript
 *  形状（`call_expression`），在 Java/Python/Rust/Go 语法上 `compileQuery` 抛 QueryError。
 *  该错误过去被吞成 `[]` → ratio 0（把"不可测"序列化成 0，违反 language-parser-extension.md §3）。
 *  现在显式区分「查询失败（UNAVAILABLE）」与「查询成功但无命中（AVAILABLE 的 0）」。 */
export type PatternAvailability = "AVAILABLE" | "UNAVAILABLE";
export type PatternUnavailableReason = "language_not_supported_by_pattern";

/** fixture 调用事实：文本（参与 minhash）+ 块级定位（证据用，镜像 definitionSurfaceFacts）。 */
export interface FixtureCallFact {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface FixtureCallProbe {
  readonly texts: readonly string[];
  readonly facts: readonly FixtureCallFact[];
  readonly availability: PatternAvailability;
  readonly reason?: PatternUnavailableReason;
}

/** 提取 fixture 调用事实（tree-sitter 定位；文本参与 minhash 相似度比较——语义主体的
 *  内容不同 → 指纹不同 → 不重复；只有跨测试近似重复的调用才算样板，校准 2026-08-08）。
 *  availability 按文件给出：两个模式都编译失败 ⇒ UNAVAILABLE（语言不受模式支持）。 */
export const fixtureCallProbe = async (parser: ParserService, file: string): Promise<FixtureCallProbe> => {
  const facts: FixtureCallFact[] = [];
  let compiled = false;
  for (const pattern of [FIXTURE_PATTERN, GIT_PATTERN]) {
    try {
      const matches = await Effect.runPromise(parser.query(file, pattern).pipe(Effect.either));
      if (matches._tag === "Left") continue;
      compiled = true;
      for (const match of matches.right) {
        const call = match.captures.find((capture) => capture.name === "call");
        if (!call) continue;
        const startLine = call.startLine ?? 1;
        facts.push({ text: call.text, startLine, endLine: call.endLine ?? startLine });
      }
    } catch {
      continue;
    }
  }
  return {
    texts: facts.map((fact) => fact.text),
    facts,
    availability: compiled ? "AVAILABLE" : "UNAVAILABLE",
    ...(compiled ? {} : { reason: "language_not_supported_by_pattern" as const }),
  };
};

/** 调用文本规范化：变量名 → _id（字符串字面量用内容哈希占位保留区分度）——
 *  mkdirSync(join(cwd,"src")) 在不同测试变量名下归一为同一指纹；而语义主体的
 *  内容差异（路径/源码字符串）哈希不同 → 指纹不同 → 不算样板。占位符必须带内容
 *  区分度：统一 __STRn__ 会抹掉字符串差异、反增相似度（校准 2026-08-08 第四轮）。 */
export const normalizeCallText = (text: string): string => {
  const keywords = new Set(["const", "let", "var", "function", "return", "if", "else", "for", "new", "await", "as", "of", "in", "true", "false", "null", "undefined"]);
  const masked = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (value) => `__STR${hash32(value, 7).toString(36)}__`);
  const normalized = masked.replace(/\b([A-Za-z_]\w*)\b/g, (match) => (keywords.has(match) ? match : "_id"));
  return normalized.replace(/\s+/g, " ").trim();
};

/**
 * 跨测试重复的 fixture 样板行数（校准 2026-08-08 第四轮）：不再是"所有 fixture 调用
 * 都算样板"——语义主体（ParserFactory 写不同源码、versionPair 建不同 git 历史）内容
 * 不同，不计入。两层判定：
 *  1. 精确层：规范化文本相同（变量名归一、字符串内容哈希保留区分度）→ 重复样板。
 *  2. 块层：相邻 fixture 调用合并为块（如 git init/config/add/commit 序列），块级
 *     minhash 近似相似 → 样板。单行短文本无足够行 shingle，minhash 只用于块。
 * 复用现成 DocumentFingerprint：codeIndexedDocument + bucketKeys + minHashSimilarity。
 */
export const fixtureBoilerplateLines = (
  calls: ReadonlyMap<string, readonly string[]>,
  blockThreshold = 0.85,
): number => {
  // 精确层：规范化文本相同 → 重复
  const exactCounts = new Map<string, { lines: number }>();
  for (const [file, texts] of calls) {
    for (const raw of texts) {
      const normalized = normalizeCallText(raw);
      const key = `${file}\u0000${normalized}`;
      const existing = exactCounts.get(key);
      if (existing) existing.lines = Math.max(existing.lines, lineCount(raw));
      else exactCounts.set(key, { lines: lineCount(raw) });
    }
  }
  // 跨文件重复：同规范化文本出现 ≥2 次
  const byNormalized = new Map<string, number>();
  const fileOf = new Map<string, string>();
  for (const [key] of exactCounts) {
    const [file, normalized] = key.split("\u0000");
    byNormalized.set(normalized, (byNormalized.get(normalized) ?? 0) + 1);
    fileOf.set(normalized, file!);
  }
  let total = 0;
  for (const [normalized, count] of byNormalized) {
    if (count >= 2) total += exactCounts.get(`${fileOf.get(normalized)}\u0000${normalized}`)!.lines;
  }

  // 块层：每文件内相邻 fixture 调用合并为 3-调用块 → minhash 跨文件相似
  const blockDocs = new Map<string, IndexedDocument>();
  const blockLines = new Map<string, number>();
  for (const [file, texts] of calls) {
    for (let start = 0; start + 2 < texts.length; start += 2) {
      const blockText = texts.slice(start, start + 3).map(normalizeCallText).join("\n");
      const key = `${file}#${start}`;
      blockDocs.set(key, codeIndexedDocument(key, blockText));
      blockLines.set(key, texts.slice(start, start + 3).reduce((sum, t) => sum + lineCount(t), 0));
    }
  }
  const buckets = new Map<string, string[]>();
  for (const [key, doc] of blockDocs) {
    for (const bucket of bucketKeys(doc.minHash)) buckets.set(bucket, [...(buckets.get(bucket) ?? []), key]);
  }
  const seen = new Set<string>();
  const repeatedBlocks = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const pair = [bucket[i]!, bucket[j]!].sort().join("\u0000");
        if (seen.has(pair)) continue;
        seen.add(pair);
        const left = blockDocs.get(bucket[i]!)!;
        const right = blockDocs.get(bucket[j]!)!;
        if (minHashSimilarity(left.minHash, right.minHash) >= blockThreshold) {
          repeatedBlocks.add(bucket[i]!);
          repeatedBlocks.add(bucket[j]!);
        }
      }
    }
  }
  total += [...repeatedBlocks].reduce((sum, key) => sum + (blockLines.get(key) ?? 0), 0);
  return total;
};

/** 每文件的重复样板行数 + 块级定位（证据用）：该文件的调用中，跨文件重复部分的贡献。
 *  与行数口径完全一致（同规范化文本出现在 ≥2 个文件才算重复），额外带一个代表性
 *  调用的行范围与样本文本（镜像 definitionSurfaceFacts 的 startLine/text）。 */
export interface FixtureBoilerplateFileEvidence {
  readonly file: string;
  readonly repeatedLines: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly sample: string;
}

export const fixtureBoilerplateEvidence = (
  calls: ReadonlyMap<string, readonly FixtureCallFact[]>,
): readonly FixtureBoilerplateFileEvidence[] => {
  // 跨文件重复判定：同规范化文本出现在 ≥2 个「文件」（同一文件内重复不算跨文件样板）
  const filesPerNormalized = new Map<string, number>();
  for (const facts of calls.values()) {
    for (const normalized of new Set(facts.map((fact) => normalizeCallText(fact.text)))) {
      filesPerNormalized.set(normalized, (filesPerNormalized.get(normalized) ?? 0) + 1);
    }
  }
  const evidence: FixtureBoilerplateFileEvidence[] = [];
  for (const [file, facts] of calls) {
    let repeatedLines = 0;
    let sample: FixtureCallFact | undefined;
    for (const fact of facts) {
      if ((filesPerNormalized.get(normalizeCallText(fact.text)) ?? 0) < 2) continue;
      repeatedLines += lineCount(fact.text);
      if (!sample || lineCount(fact.text) > lineCount(sample.text)) sample = fact;
    }
    if (repeatedLines === 0 || !sample) continue;
    evidence.push({
      file,
      repeatedLines,
      startLine: sample.startLine,
      endLine: sample.endLine,
      sample: sample.text.split("\n").slice(0, 2).join("\n"),
    });
  }
  return evidence.sort((left, right) => right.repeatedLines - left.repeatedLines);
};
