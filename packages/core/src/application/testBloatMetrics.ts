import { Effect } from "effect";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bucketKeys, codeIndexedDocument, minHashSimilarity, type IndexedDocument } from "../document-store/DocumentFingerprint";
import { execFileHidden } from "../infra/childProcess";
import { normalizeRepositoryPath } from "../script-runtime/projectFacts";
import { fixtureBoilerplateByFile, fixtureBoilerplateLines, fixtureCallTexts, normalizeCallText } from "./fixtureBoilerplate";
import type { ParserService } from "../port/ParserService";

/** 测试膨胀指标（校准 2026-08-08）——全部静态可算：
 *  - fixture 样板比例：tree-sitter 查询 fixture/git 调用（语法分析）
 *  - 相似块比例：块级 minhash（复用 DocumentFingerprint 内核 + LSH band 候选）
 *  - 大小离散：最大文件/中位数（行数）
 *  - 增长比：近 N 提交测试行增量/生产行增量（git numstat）
 *  - 弱断言比例：tree-sitter 查询（弱断言/总断言）
 *  score > 0.5 触发 TEST_BLOAT 信号（提醒 agent 开始测试膨胀治理）。 */

/** 测试膨胀因子证据（校准 2026-08-08）：触发时给出具体文件，避免 agent 无效探索。
 *  与其他治理路径对齐（反模式 AntiPatternHit{file,line}、定义面信号 → path: decl=X）：
 *  每个触发因子列出 Top-N 贡献文件（仓库相对路径）。 */
export interface TestBloatEvidence {
  readonly factor: "fixtureBoilerplateRatio" | "codeSimilarityRatio" | "sizeDispersion" | "growthRatio" | "weakAssertionRatio";
  readonly file: string;
  readonly value: number;
  readonly detail: string;
}

export interface TestBloatMetrics {
  readonly fixtureBoilerplateRatio: number;
  readonly codeSimilarityRatio: number;
  readonly sizeDispersion: number;
  readonly growthRatio: number;
  readonly weakAssertionRatio: number;
  readonly score: number;
  readonly triggered: boolean;
  readonly parts: readonly { readonly name: string; readonly value: number; readonly threshold: number; readonly weight: number; readonly contribution: number; readonly suggestion: string }[];
  /** 触发因子的文件级证据（仅触发因子，每因子 Top-3）。 */
  readonly evidence: readonly TestBloatEvidence[];
}

/** 权重向量（与 parts 顺序一一对应）——score = Σ contribution 的数学闭环由计算器保证。 */
export const TEST_BLOAT_WEIGHTS = [0.30, 0.30, 0.20, 0.10, 0.10] as const;

const EXPECT_PATTERN = "(call_expression function: (identifier) @fn (#eq? @fn \"expect\")) @call";
const WEAK_PATTERN = "(call_expression function: (member_expression property: (property_identifier) @p (#match? @p \"^(toBeTruthy|toBeDefined)$\"))) @call";

const lineCount = (text: string): number => (text.match(/\r?\n/g)?.length ?? 0) + 1;

/** tree-sitter 查询命中行数（近似：捕获文本行数之和）。 */
const queryLineCount = async (parser: ParserService, file: string, pattern: string): Promise<number> => {
  try {
    const matches = await Effect.runPromise(parser.query(file, pattern).pipe(Effect.either));
    if (matches._tag === "Left") return 0;
    return matches.right.reduce((sum, match) => sum + match.captures.reduce((s, capture) => s + lineCount(capture.text), 0), 0);
  } catch {
    return 0;
  }
};

const totalLines = (content: string): number => lineCount(content);

/** 块级 minhash 相似度聚合：每个测试文件按行窗口切块，块签名（复用 minhash
 *  内核 + LSH band 候选 + minHashSimilarity 验证）——重复 setup 样板块比例。
 *  返回「强重复块行数 / 总行数」：重复样板块占测试代码的真实比重（校准 2026-08-08）。 */
export const codeSimilarityRatio = (files: readonly string[], blockWindow = 8, threshold = 0.6): number => {
  // 块级文档指纹（与文件级同构：行 shingle → 64 维 minhash）
  const blockDocuments = new Map<string, IndexedDocument>();
  const totalBlockLines = new Map<string, number>();
  let totalLinesAll = 0;
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    totalLinesAll += lines.length;
    for (let start = 0; start + blockWindow <= lines.length; start += Math.max(1, Math.floor(blockWindow / 2))) {
      const blockText = lines.slice(start, start + blockWindow).join("\n");
      const key = `${file}#${start}`;
      blockDocuments.set(key, codeIndexedDocument(key, blockText));
      totalBlockLines.set(key, lines.slice(start, start + blockWindow).filter((line) => line.trim().length > 0).length);
    }
  }
  if (blockDocuments.size === 0 || totalLinesAll === 0) return 0;
  // LSH band 候选：同桶块对（复用 DocumentFingerprint 的 bucketKeys——8 维 band）
  const buckets = new Map<string, string[]>();
  for (const [key, doc] of blockDocuments) {
    for (const bucket of bucketKeys(doc.minHash)) buckets.set(bucket, [...(buckets.get(bucket) ?? []), key]);
  }
  // 候选对（同 band）→ minHashSimilarity 验证 → 统计强重复块涉及的重复行
  const seen = new Set<string>();
  const repeatedLines = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const pair = [bucket[i]!, bucket[j]!].sort().join("\u0000");
        if (seen.has(pair)) continue;
        seen.add(pair);
        const left = blockDocuments.get(bucket[i]!)!;
        const right = blockDocuments.get(bucket[j]!)!;
        if (minHashSimilarity(left.minHash, right.minHash) >= threshold) {
          repeatedLines.add(bucket[i]!);
          repeatedLines.add(bucket[j]!);
        }
      }
    }
  }
  const repeatedLineCount = [...repeatedLines].reduce((sum, key) => sum + (totalBlockLines.get(key) ?? 0), 0);
  return repeatedLineCount / totalLinesAll;
};

/** 相似块涉及的文件级证据：每个文件的重复块行数（Top-3，降序）。 */
export const codeSimilarityEvidence = (files: readonly string[], blockWindow = 8, threshold = 0.6): readonly { file: string; repeatedLines: number }[] => {
  const blockDocuments = new Map<string, IndexedDocument>();
  const totalBlockLines = new Map<string, number>();
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let start = 0; start + blockWindow <= lines.length; start += Math.max(1, Math.floor(blockWindow / 2))) {
      const blockText = lines.slice(start, start + blockWindow).join("\n");
      const key = `${file}#${start}`;
      blockDocuments.set(key, codeIndexedDocument(key, blockText));
      totalBlockLines.set(key, lines.slice(start, start + blockWindow).filter((line) => line.trim().length > 0).length);
    }
  }
  const buckets = new Map<string, string[]>();
  for (const [key, doc] of blockDocuments) {
    for (const bucket of bucketKeys(doc.minHash)) buckets.set(bucket, [...(buckets.get(bucket) ?? []), key]);
  }
  const seen = new Set<string>();
  const repeatedLines = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const pair = [bucket[i]!, bucket[j]!].sort().join("\u0000");
        if (seen.has(pair)) continue;
        seen.add(pair);
        const left = blockDocuments.get(bucket[i]!)!;
        const right = blockDocuments.get(bucket[j]!)!;
        if (minHashSimilarity(left.minHash, right.minHash) >= threshold) {
          repeatedLines.add(bucket[i]!);
          repeatedLines.add(bucket[j]!);
        }
      }
    }
  }
  const byFile = new Map<string, number>();
  for (const key of repeatedLines) {
    const file = key.split("#").slice(0, -1).join("#");
    byFile.set(file, (byFile.get(file) ?? 0) + (totalBlockLines.get(key) ?? 0));
  }
  return [...byFile.entries()]
    .map(([file, repeatedLines]) => ({ file, repeatedLines }))
    .sort((a, b) => b.repeatedLines - a.repeatedLines)
    .slice(0, 3);
};

/**
 * 测试文件尺寸离散（校准 2026-08-08）：max 相对自然右尾 P95 的脱离度。
 * 测试文件的"大"与生产不同——完整覆盖矩阵（同一被测对象 30 个 it）合法，
 * 不应按 max/median 倍数误判（JsonFileStorage 502 行只是 P95 292 的 1.72 倍）。
 * 语义：仅当 max 超过本套测试文件 95 分位 2 倍（自然右尾的两倍）才提示异常。
 * 倍率常量 2.0 + 动态 P95，非绝对行数硬编码。样本过少（≤5）时 P95=max，值恒 1。 */
const sizeDispersion = (files: readonly string[]): { dispersion: number; maxFile?: string; maxLines: number; p95: number } => {
  const sizes = files.map((file) => ({ file, lines: totalLines(readFileSync(file, "utf8")) })).sort((a, b) => a.lines - b.lines);
  if (sizes.length <= 5) return { dispersion: 1, maxLines: sizes.at(-1)?.lines ?? 0, p95: sizes.at(-1)?.lines ?? 1 }; // 小样本无离散可言：P95=max → 脱离度恒 1
  const p95Index = Math.min(sizes.length - 1, Math.floor(sizes.length * 0.95));
  const p95 = sizes[p95Index]?.lines ?? 1;
  const max = sizes[sizes.length - 1]!;
  return { dispersion: max.lines / Math.max(1, p95), maxFile: max.file, maxLines: max.lines, p95 };
};

/** 近 N 提交测试行增量 / 生产行增量（git numstat——外部事实，失败返回 0）。 */
export const testGrowthRatio = (cwd: string, commits = 25): number => {
  try {
    const output = execFileHidden("git", ["log", `--numstat`, `-${commits}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    let testDelta = 0;
    let sourceDelta = 0;
    for (const line of output.split(/\r?\n/)) {
      const parts = line.split("\t");
      if (parts.length !== 3) continue;
      const added = Number(parts[0]);
      const removed = Number(parts[1]);
      const path = parts[2] ?? "";
      if (Number.isNaN(added) || Number.isNaN(removed)) continue;
      if (path.includes(".test.ts") || path.endsWith(".test.ts")) testDelta += added + removed;
      else if (path.endsWith(".ts")) sourceDelta += added + removed;
    }
    return sourceDelta === 0 ? 0 : testDelta / sourceDelta;
  } catch {
    return 0;
  }
};

export const testBloatMetrics = async (cwd: string, files: readonly string[], parser: ParserService): Promise<TestBloatMetrics> => {
  let allLines = 0;
  let expectTotal = 0;
  let weakTotal = 0;
  const fixtureCalls = new Map<string, readonly string[]>();
  const weakByFile = new Map<string, { weak: number; expect: number }>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    allLines += totalLines(content);
    const calls = await fixtureCallTexts(parser, file);
    fixtureCalls.set(file, calls);
    const expect = await queryLineCount(parser, file, EXPECT_PATTERN);
    expectTotal += expect;
    const weak = await queryLineCount(parser, file, WEAK_PATTERN);
    weakTotal += weak;
    weakByFile.set(file, { weak, expect });
  }
  const fixtureLinesTotal = fixtureBoilerplateLines(fixtureCalls);
  const fixtureByFile = fixtureBoilerplateByFile(fixtureCalls);
  const fixtureRatio = allLines === 0 ? 0 : fixtureLinesTotal / allLines;
  const similarityRatio = codeSimilarityRatio(files);
  const size = sizeDispersion(files);
  const dispersion = size.dispersion;
  const growth = testGrowthRatio(cwd);
  const weakRatio = expectTotal === 0 ? 0 : weakTotal / expectTotal;

  // 触发因子的文件级证据（校准 2026-08-08）——与其他治理路径对齐：agent 能直接定位
  const evidence: TestBloatEvidence[] = [];
  if (fixtureRatio > 0.08) {
    for (const [file, value] of [...fixtureByFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      evidence.push({ factor: "fixtureBoilerplateRatio", file: normalizeRepositoryPath(file, cwd), value, detail: `fixture 调用 ${value} 行` });
    }
  }
  if (similarityRatio > 0.06) {
    for (const { file, repeatedLines } of codeSimilarityEvidence(files)) {
      evidence.push({ factor: "codeSimilarityRatio", file: normalizeRepositoryPath(file, cwd), value: repeatedLines, detail: `与其它文件共享相似块 ${repeatedLines} 行` });
    }
  }
  if (dispersion > 2 && size.maxFile) {
    evidence.push({ factor: "sizeDispersion", file: normalizeRepositoryPath(size.maxFile, cwd), value: size.maxLines, detail: `${size.maxLines} 行（本套 P95=${size.p95}）` });
  }
  if (weakRatio > 0.03) {
    for (const [file, { weak, expect }] of [...weakByFile.entries()].filter(([, v]) => v.weak > 0).sort((a, b) => b[1].weak - a[1].weak).slice(0, 3)) {
      evidence.push({ factor: "weakAssertionRatio", file: normalizeRepositoryPath(file, cwd), value: weak, detail: `弱断言 ${weak}/${expect} 处` });
    }
  }

  const parts = [
    { name: "fixtureBoilerplateRatio", value: fixtureRatio, threshold: 0.08, suggestion: "提取共享测试工具（fixture builder / temp-dir helper），消除各测试文件重复的 setup/teardown 样板" },
    { name: "codeSimilarityRatio", value: similarityRatio, threshold: 0.06, suggestion: "高相似测试块聚类：抽取公共 fixture 工厂并参数化差异（路径/时间戳/随机值）" },
    { name: "sizeDispersion", value: dispersion, threshold: 2, suggestion: "测试文件允许完整覆盖矩阵（同主题多用例）；仅当 max 超过本套测试文件 P95 的 2 倍（自然右尾两倍）才需检查是否多个无关主题挤在一个文件" },
    { name: "growthRatio", value: growth, threshold: 1.5, suggestion: "测试行数增长持续快于实现：检查是否每处改动都叠加新用例，考虑表驱动/参数化合并重复" },
    { name: "weakAssertionRatio", value: weakRatio, threshold: 0.03, suggestion: "低信息量断言（存在性/布尔断言）占比偏高：改为断言具体值与错误类型，让失败可定位" },
  ] as const;
  const weighted = parts.map((part, index) => {
    const weight = TEST_BLOAT_WEIGHTS[index] ?? 0;
    return { ...part, weight, contribution: weight * Math.min(1, part.value / part.threshold) };
  });
  const score = weighted.reduce((sum, part) => sum + part.contribution, 0);
  return { fixtureBoilerplateRatio: fixtureRatio, codeSimilarityRatio: similarityRatio, sizeDispersion: dispersion, growthRatio: growth, weakAssertionRatio: weakRatio, score, triggered: score > 0.5, parts: weighted, evidence };
};

/** 测试文件收集（排除 node_modules/dist）。 */
export const listTestFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") walk(path);
      } else if (entry.name.endsWith(".test.ts")) out.push(path);
    }
  };
  walk(root);
  return out;
};
