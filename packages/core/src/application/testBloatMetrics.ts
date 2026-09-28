import { Effect } from "effect";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bucketKeys, codeIndexedDocument, minHashSimilarity, type IndexedDocument } from "../document-store/DocumentFingerprint";
import { execFileHidden } from "../infra/childProcess";
import { normalizeRepositoryPath } from "../script-runtime/projectFacts";
import { fixtureBoilerplateEvidence, fixtureBoilerplateLines, fixtureCallProbe, type FixtureCallFact, type PatternAvailability, type PatternUnavailableReason } from "./fixtureBoilerplate";
import { JUNIT_ASSERTION_METHODS, WEAK_JUNIT_ASSERTION_METHODS, WEAK_TS_ASSERTION_METHODS, assertionSyntaxLanguageFor, blockEvidenceQueryFor, classifyBlockSemantics, type BlockLineEvidence } from "../test-governance/assertionRecognition";
import type { ProjectShapes, ShapesSource } from "../domain/languageShapes";
import type { ParserService } from "../port/ParserService";

/** 测试膨胀指标（校准 2026-08-08）——全部静态可算：
 *  - fixture 样板比例：tree-sitter 查询 fixture/git 调用（语法分析）
 *  - 相似块比例：块级 minhash（复用 DocumentFingerprint 内核 + LSH band 候选）
 *  - 大小离散：最大文件/中位数（行数）
 *  - 增长比：近 N 提交测试行增量/生产行增量（git numstat）
 *  - 弱断言比例：tree-sitter 查询（弱断言/总断言）
 *  score > 0.5 触发 TEST_BLOAT 信号（提醒 agent 开始测试膨胀治理）。
 *
 *  可测性（缺陷修复 2026-09-25）：fixtureBoilerplateRatio / growthRatio / weakAssertionRatio
 *  的输入事实是 TypeScript/JavaScript 形状的（`call_expression` 模式、`.test.ts` numstat），
 *  Java/Python/Rust/Go-only 项目上根本测不到。旧实现把这些写 0 并计入分母 ⇒
 *  score ≤ 0.30+0.20 = 0.50，而触发是严格 `> 0.5` ⇒ TEST_BLOAT 数学不可达。
 *  现在不可测因子报 UNAVAILABLE + reason，并从归一化分母中剔除。 */

/** 因子可测性：AVAILABLE = 已测得（0 是真实的 0）；UNAVAILABLE = 输入事实不可测（绝不写 0）。 */
export type TestBloatAvailability = PatternAvailability;
/** 不可测原因（机器可读 token，语言中立）：
 *  - language_not_supported_by_pattern：tree-sitter 模式是 TS/JS 形状，目标语言语法不识别
 *  - no_assertion_facts：模式可编译但没有任何 expect 形状断言（0/0 无定义）
 *  - no_language_matched_history：git 历史里没有任何被计数的 TS/JS 路径
 *  - no_production_delta：git 历史有测试增量但无生产增量（分母为 0）
 *  - not_a_git_repository：git 事实不可读
 *  - no_test_files：没有发现测试文件，无因子可测 */
export type TestBloatUnavailableReason =
  | PatternUnavailableReason
  | "no_assertion_facts"
  | "no_language_matched_history"
  | "no_production_delta"
  | "not_a_git_repository"
  | "no_test_files";

export type TestBloatFactor = "fixtureBoilerplateRatio" | "codeSimilarityRatio" | "sizeDispersion" | "growthRatio" | "weakAssertionRatio";

/** 测试膨胀因子证据（校准 2026-08-08）：触发时给出具体文件，避免 agent 无效探索。
 *  与其他治理路径对齐（反模式 AntiPatternHit{file,line}、定义面信号 → path: decl=X）：
 *  每个触发因子列出 Top-N 贡献文件（仓库相对路径）+ 块级定位（startLine/endLine/sample，
 *  镜像 definitionSurfaceFacts 的 DefinitionSurfaceSimilarityBlock——旧实现只给"文件 +
 *  非空行数"，块行范围与内容被丢弃）。 */
export interface TestBloatEvidence {
  readonly factor: TestBloatFactor;
  readonly file: string;
  readonly value: number;
  readonly detail: string;
  /** 1-based 块起始行（文件级因子取 1）。 */
  readonly startLine: number;
  /** 1-based 块结束行。 */
  readonly endLine: number;
  /** 块样本文本（最多 2 行；不可测因子不产生证据）。 */
  readonly sample: string;
}

export interface TestBloatPart {
  readonly name: TestBloatFactor;
  /** 测得值；UNAVAILABLE 时缺省（绝不把不可测写成 0）。 */
  readonly value?: number;
  readonly threshold: number;
  readonly weight: number;
  /** 归一化输入：UNAVAILABLE 时为 0（已被剔除出分母，非测得的 0）。 */
  readonly contribution: number;
  readonly availability: TestBloatAvailability;
  readonly reason?: TestBloatUnavailableReason;
  readonly suggestion: string;
}

export interface TestBloatMetrics {
  readonly fixtureBoilerplateRatio?: number;
  readonly codeSimilarityRatio?: number;
  readonly sizeDispersion?: number;
  readonly growthRatio?: number;
  readonly weakAssertionRatio?: number;
  /**
   * 弱断言判据生效的名单来源（**非破坏追加字段**，report-only，§6/Q1 要求的披露）：
   * `project` = 项目在 `shapes` 里声明了该语言的 `weak_assertion_methods`；`builtin` = 内置默认。
   * 声明是按语言的：不同语言的测试文件可能落在不同来源，因此这里是**投影**，
   * 多语言下取任一**已声明**语言（`project` 优先）——缺失表示本次没有可测的语言绑定文件。
   * `builtin` 的含义是"**被测语言**没有项目声明"，**不是**"项目未声明 shapes"（项目可能声明了
   * 另一个语言）：报告文案必须照此措辞，否则会出现一句与事实不符的陈述（2026-09-27 复验）。
   */
  readonly weakAssertionShapesSource?: ShapesSource;
  /** Σ contribution / Σ 可用权重（全不可测时为 0）。 */
  readonly score: number;
  /** 归一化分母：可用因子权重之和（全部可用 = 1.0）。 */
  readonly availableWeight: number;
  readonly triggered: boolean;
  readonly parts: readonly TestBloatPart[];
  /** 触发因子的文件级证据（仅触发因子，每因子 Top-3）。 */
  readonly evidence: readonly TestBloatEvidence[];
  /**
   * DRY/DAMP 分桶（report-only 观察值，**不进权重表**）：`codeSimilarityRatio` 只对
   * "无调用点"的重复块计分，这里把另外两类并排列出，让"少扣的部分"可见而不是消失。
   * 缺块语义证据的文件（Go/Rust）按其总量计入 assembly，并由 `filesWithoutBlockEvidence` 标注边界。
   */
  readonly similarityBuckets: {
    /** 计分：完全在用例体之外、且无可证明断言的重复（装配样板）。 */
    readonly assemblyRatio: number;
    /** 计分但未证实：文件无用例 span（未识别出用例）时的调用块重复。 */
    readonly unclassifiedRatio: number;
    /** 不计分：含已识别断言/验证调用点的重复 —— DAMP 侧，**不该为它抽 helper**。 */
    readonly assertionRatio: number;
    /** 不计分：位于已识别用例体内的重复（DAMP 侧，含 arrange）。 */
    readonly caseBodyRatio: number;
    /** 语言无块语义查询（Go/Rust）：其重复按总量计分，属事实边界。 */
    readonly filesWithoutBlockEvidence: number;
    /** 有块语义但未识别出任何用例：不启用体界判据，退回 unclassified 口径。 */
    readonly filesWithoutCaseSpans: number;
    /** 用例体证据的可用性（`not_requested` = 调用方未传 spans）。 */
    readonly caseSpansAvailability: "available" | "partial" | "unavailable" | "not_requested";
  };
}

/** 权重向量（与 parts 顺序一一对应）——score = Σ contribution / Σ 可用权重；
 *  全部可用时 Σw = 1.0，与旧公式 `Σ contribution` 逐位一致。 */
export const TEST_BLOAT_WEIGHTS = [0.30, 0.30, 0.20, 0.10, 0.10] as const;

/**
 * 弱断言因子的语言形状（D-G2，2026-09-25，项目所有者批准"优先补全 Java 形状"）。
 *
 * 缺陷：两个模式写死成 TypeScript 形状，于是 Java 项目**即使有活跃 provider、1350 个用例**，
 * `weakAssertionRatio` 也报 `language_not_supported_by_pattern`（5 因子中 2 个恒不可测）。
 *
 * 认知点纪律：断言的**名字**权威在 `../test-governance/assertionRecognition`
 * （`JUNIT_ASSERTION_METHODS` / `WEAK_JUNIT_ASSERTION_METHODS`），此处只把名单 **join 成
 * regex 交替**，不手抄名字——名单增删会自动反映到探针上，二者不可能漂移。
 * TS 形状保持原样（既有两个模式逐字不变），因此 TS/JS 已校准的分数**逐位不变**。
 *
 * 可配置语言形状（2026-09-27，§6/Q1 **覆盖**）：`weak_assertion_methods` 改为**按解析后
 * 的名字集合**构造模式。**只有弱断言名单可被项目覆盖**；断言**分母**的名单
 * （`JUNIT_ASSERTION_METHODS`、TS 的 `expect`）保持内置——改变分母会改变
 * `weakAssertionRatio` 的语义（它是"弱断言/总断言"），而 v1 契约只声明了弱断言形状。
 * 未声明 ⇒ 传入内置集合 ⇒ 两个模式**逐字不变**。
 */
const alternation = (names: ReadonlySet<string>): string => [...names].join("|");
const JAVA_ASSERTION_PATTERN = `(method_invocation name: (identifier) @fn (#match? @fn "^(?:${alternation(JUNIT_ASSERTION_METHODS)})$")) @call`;
/**
 * TS 系两个模式**逐字保持 2026-08-08 校准时的形状**（弱断言名同样由权威集合派生）：
 * 分母是 `expect` 调用点，这与 `blockEvidenceQueryFor("ts")` 的块语义判据（`expect|assert`）
 * **故意不同**——块语义回答"这段重复算不算断言"，膨胀因子沿用已封存分数的旧口径，
 * 改它会同时改变已校准的 TS/JS 分数，属另行校准批次。
 */
const TS_ASSERTION_PATTERN = "(call_expression function: (identifier) @fn (#eq? @fn \"expect\")) @call";
const javaWeakPattern = (names: ReadonlySet<string>): string =>
  `(method_invocation name: (identifier) @fn (#match? @fn "^(?:${alternation(names)})$")) @call`;
const tsWeakPattern = (names: ReadonlySet<string>): string =>
  `(call_expression function: (member_expression property: (property_identifier) @p (#match? @p "^(?:${alternation(names)})$"))) @call`;

/**
 * 该文件适用的 [断言调用, 弱断言调用] 模式对 + **弱断言名单来源**；
 * 语言无对应语法时 undefined（保持 UNAVAILABLE）。
 *
 * 弱断言名单的来源按语言裁决（§6/Q1 覆盖语义 + §6/Q3 不新增 population 权威）：
 * - 项目声明了**该语言**的 `weak_assertion_methods` ⇒ 用项目名单（`project`）；
 * - 否则用内置名单（`builtin`）。
 * 声明是按**语言**的，因此同一仓库里"声明了 Java、没声明 TS"时两者各自生效——
 * 这正是"语言形状"的字面含义（不是全仓开关）。
 */
const weakAssertionPatternsFor = (
  file: string,
  shapes: ProjectShapes,
): { readonly patterns: readonly [string, string]; readonly source: ShapesSource } | undefined => {
  const language = assertionSyntaxLanguageFor(file);
  if (language === undefined) return undefined;
  const declared = language === "java" ? shapes.java?.weakAssertionMethods : language === "ts" ? shapes.typescript?.weakAssertionMethods : undefined;
  const usesDeclaredList = declared !== undefined && declared.length > 0;
  const names = usesDeclaredList ? new Set(declared) : undefined;
  const source: ShapesSource = usesDeclaredList ? "project" : "builtin";
  return language === "java"
    ? { patterns: [JAVA_ASSERTION_PATTERN, javaWeakPattern(names ?? WEAK_JUNIT_ASSERTION_METHODS)], source }
    : language === "ts"
      ? { patterns: [TS_ASSERTION_PATTERN, tsWeakPattern(names ?? WEAK_TS_ASSERTION_METHODS)], source }
      : undefined;
};

/** 相似度阈值与块窗口的**唯一来源**（此前 0.06 在证据门控与因子定义各写一次）。 */
const SIMILARITY_THRESHOLD = 0.06;
const SIMILARITY_BLOCK_WINDOW = 8;
const SIMILARITY_MINHASH_THRESHOLD = 0.6;

/**
 * provider 确认的用例体范围（`test-case-spans` 事实域）→ 按文件展开成行集合。
 * provider 给的是**用例体**（不含签名/注解行），因此判据是"块是否与体相交"。
 * 键是绝对路径，与 `discoveredTestFiles` 同一空间（不引入第二个路径约定）。
 */
export interface BloatCaseSpanInput {
  readonly availability: "available" | "partial" | "unavailable";
  readonly reason?: string;
  readonly spans: readonly { readonly file: string; readonly startLine: number; readonly endLine: number }[];
}

const caseBodyLineIndex = (input?: BloatCaseSpanInput): ReadonlyMap<string, ReadonlySet<number>> => {
  const byFile = new Map<string, Set<number>>();
  for (const span of input?.spans ?? []) {
    const lines = byFile.get(span.file) ?? new Set<number>();
    const end = Math.max(span.startLine, span.endLine);
    for (let line = span.startLine; line <= end; line++) lines.add(line);
    byFile.set(span.file, lines);
  }
  return byFile;
};

const lineCount = (text: string): number => (text.match(/\r?\n/g)?.length ?? 0) + 1;

/** 块级定位（证据用）。 */
interface BlockSpan {
  readonly startLine: number;
  readonly endLine: number;
  readonly sample: string;
}

/** tree-sitter 查询探针：行数与旧 queryLineCount 口径一致（所有捕获文本行数之和，
 *  保持 TS/JS 分数逐位不变），额外给出编译是否成功（UNAVAILABLE 判定）与 @call 块定位。 */
interface PatternProbe {
  readonly lines: number;
  readonly compiled: boolean;
  readonly spans: readonly BlockSpan[];
}

const patternProbe = async (parser: ParserService, file: string, pattern: string): Promise<PatternProbe> => {
  try {
    const matches = await Effect.runPromise(parser.query(file, pattern).pipe(Effect.either));
    if (matches._tag === "Left") return { lines: 0, compiled: false, spans: [] };
    const spans: BlockSpan[] = [];
    const lines = matches.right.reduce((sum, match) => {
      // 一次匹配只计一次（2026-09-27 复验修正）：此前累加**每个 capture** 的行数，而本模块用的
      // 每个模式都有 2 个 capture（`@fn`/`@p` + `@call`）⇒ 分子与分母同源翻倍，报告里的
      // "弱断言 4/6 处"是事实（2/3）的两倍。比率不受影响（故分数与裁决一直正确），但**证据数字
      // 与事实不符**。以 `@call`（匹配到的调用点）为计数权威；没有 `@call` 的模式退回首个 capture。
      const counted = match.captures.find((capture) => capture.name === "call") ?? match.captures[0];
      for (const capture of match.captures) {
        if (capture.name !== "call") continue;
        const startLine = capture.startLine ?? 1;
        spans.push({ startLine, endLine: capture.endLine ?? startLine, sample: capture.text.split("\n").slice(0, 2).join("\n") });
      }
      return sum + (counted === undefined ? 0 : lineCount(counted.text));
    }, 0);
    return { lines, compiled: true, spans };
  } catch {
    return { lines: 0, compiled: false, spans: [] };
  }
};

const totalLines = (content: string): number => lineCount(content);

/**
 * 块语义证据（DRY/DAMP 平衡的输入）：一次调用查询即同时得到「调用点行」与「断言/验证行」
 * （Python 的 `assert` 是语句不是调用，额外一条查询）。语言无对应语法时返回 undefined
 * ——此时**不冒充分类过**，见 `codeSimilarityBuckets`。
 */
const blockLineEvidence = async (parser: ParserService, file: string, caseBodyLines?: ReadonlySet<number>): Promise<BlockLineEvidence | undefined> => {
  const language = assertionSyntaxLanguageFor(file);
  if (!language) return undefined;
  const query = blockEvidenceQueryFor(language);
  const span = (capture: { readonly startLine?: number; readonly endLine?: number }): readonly number[] => {
    const start = capture.startLine ?? 1;
    const end = Math.max(start, capture.endLine ?? start);
    const lines: number[] = [];
    for (let line = start; line <= end; line++) lines.push(line);
    return lines;
  };
  // 宽口径调用点：成员调用也算，否则 `service.save(x)` 会被当成"无调用块"。
  const calls = await Effect.runPromise(parser.query(file, query.callPattern).pipe(Effect.either));
  if (calls._tag === "Left") return undefined;
  const callLines = new Set<number>();
  for (const match of calls.right) {
    for (const capture of match.captures) if (capture.name === "call") for (const line of span(capture)) callLines.add(line);
  }
  const assertionLines = new Set<number>();
  if (query.namedCallPattern) {
    const named = await Effect.runPromise(parser.query(file, query.namedCallPattern).pipe(Effect.either));
    if (named._tag === "Right") {
      for (const match of named.right) {
        const name = match.captures.find((capture) => capture.name === "name")?.text;
        if (!query.isAssertionName(name)) continue;
        for (const capture of match.captures) if (capture.name === "call") for (const line of span(capture)) assertionLines.add(line);
      }
    }
  }
  if (query.statementAssertionPattern) {
    const statements = await Effect.runPromise(parser.query(file, query.statementAssertionPattern).pipe(Effect.either));
    if (statements._tag === "Right") {
      for (const match of statements.right) {
        for (const capture of match.captures) {
          if (capture.name !== "call") continue;
          for (const line of span(capture)) { assertionLines.add(line); callLines.add(line); }
        }
      }
    }
  }
  return { assertionLines, callLines, ...(caseBodyLines && caseBodyLines.size > 0 ? { caseBodyLines } : {}) };
};

/** 块索引：三个消费者（计分 / 分桶 / 文件证据）共用一次切块 + 一次指纹。 */
interface BlockIndex {
  readonly documents: Map<string, IndexedDocument>;
  /** 非空行数（分子口径）。 */
  readonly blockLines: Map<string, number>;
  /** 1-based 起始行。 */
  readonly blockStart: Map<string, number>;
  readonly blockSample: Map<string, string>;
  readonly totalLinesAll: number;
}

const BLOCK_STRIDE = (blockWindow: number): number => Math.max(1, Math.floor(blockWindow / 2));

const indexBlocks = (files: readonly string[], blockWindow: number): BlockIndex => {
  const documents = new Map<string, IndexedDocument>();
  const blockLines = new Map<string, number>();
  const blockStart = new Map<string, number>();
  const blockSample = new Map<string, string>();
  let totalLinesAll = 0;
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    totalLinesAll += lines.length;
    for (let start = 0; start + blockWindow <= lines.length; start += BLOCK_STRIDE(blockWindow)) {
      const blockText = lines.slice(start, start + blockWindow).join("\n");
      const key = `${file}#${start}`;
      documents.set(key, codeIndexedDocument(key, blockText));
      blockLines.set(key, lines.slice(start, start + blockWindow).filter((line) => line.trim().length > 0).length);
      blockStart.set(key, start + 1);
      blockSample.set(key, blockText.split("\n").slice(0, 2).join("\n"));
    }
  }
  return { documents, blockLines, blockStart, blockSample, totalLinesAll };
};

/** 强重复块集合：LSH band 候选 → `minHashSimilarity` 验证。 */
const repeatedBlocksOf = (index: BlockIndex, threshold: number): ReadonlySet<string> => {
  const buckets = new Map<string, string[]>();
  for (const [key, doc] of index.documents) {
    for (const bucket of bucketKeys(doc.minHash)) buckets.set(bucket, [...(buckets.get(bucket) ?? []), key]);
  }
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const pair = [bucket[i]!, bucket[j]!].sort().join("\u0000");
        if (seen.has(pair)) continue;
        seen.add(pair);
        const left = index.documents.get(bucket[i]!)!;
        const right = index.documents.get(bucket[j]!)!;
        if (minHashSimilarity(left.minHash, right.minHash) >= threshold) {
          repeated.add(bucket[i]!);
          repeated.add(bucket[j]!);
        }
      }
    }
  }
  return repeated;
};

const fileOfBlock = (key: string): string => key.split("#").slice(0, -1).join("#");

/**
 * 相似度分桶（DRY/DAMP 平衡，校准 2026-09-25）：重复块按**块语义**分类。
 *
 * 正向依据是 provider 确认的**用例体范围**（`test-case-spans`）：与用例体相交的块是测试语义
 * （DAMP，不计分），完全在用例体之外的块才是装配样板（可 DRY，计分）。断言调用名是更细的信号。
 *
 * - `assertion`：含已识别断言/验证调用点 ⇒ 不计分，单列（"不该为它抽 helper"）；
 * - `caseBody`：与已识别用例体相交 ⇒ 不计分（用例内的 arrange 与测量协议都属 DAMP）；
 * - `assembly`：完全在用例体之外、且无断言 ⇒ 计分；
 * - `unclassified`：该文件**没有**用例体证据（未识别出用例）⇒ 退回"有无调用点"的弱判据，
 *   有调用则计入本桶：**仍计分**但标注"并非已证实是装配样板"（见 `classifyBlockSemantics`）。
 *
 * 计分分子 = 装配 + 未分类；缺块语义证据（Go/Rust）与缺用例 span 的文件都按总量计分，
 * 并由下面的计数字段如实标注边界——绝不把"没有证据"当作"已经分类过"。
 */
export interface CodeSimilarityBuckets {
  /** 计分：完全在用例体之外、且无可证明断言。 */
  readonly assemblyLines: number;
  /** 计分但未证实：文件无用例 span，且块内有调用。 */
  readonly unclassifiedLines: number;
  /** 不计分：含已识别断言/验证调用点（DAMP 侧）。 */
  readonly assertionLines: number;
  /** 不计分：位于已识别用例体内（DAMP 侧，含 arrange）。 */
  readonly caseBodyLines: number;
  readonly denominatorLines: number;
  /** 语言无块语义查询（Go/Rust）：其重复按总量计入 assembly。 */
  readonly filesWithoutBlockEvidence: number;
  /** 有块语义但该文件未识别出任何用例：不启用体界判据，退回 unclassified 口径。 */
  readonly filesWithoutCaseSpans: number;
}

/** 计分分子 = 装配 + 未分类（仅排除可证明的断言与用例体块）。 */
export const chargedSimilarityLines = (buckets: CodeSimilarityBuckets): number => buckets.assemblyLines + buckets.unclassifiedLines;

export const codeSimilarityBuckets = (
  files: readonly string[],
  evidence: ReadonlyMap<string, BlockLineEvidence | undefined>,
  blockWindow = 8,
  threshold = 0.6,
): CodeSimilarityBuckets => {
  const index = indexBlocks(files, blockWindow);
  const empty: CodeSimilarityBuckets = {
    assemblyLines: 0, unclassifiedLines: 0, assertionLines: 0, caseBodyLines: 0,
    denominatorLines: index.totalLinesAll, filesWithoutBlockEvidence: 0, filesWithoutCaseSpans: 0,
  };
  if (index.documents.size === 0 || index.totalLinesAll === 0) return empty;
  const repeated = repeatedBlocksOf(index, threshold);
  let assemblyLines = 0;
  let unclassifiedLines = 0;
  let assertionLines = 0;
  let caseBodyLines = 0;
  const filesWithoutBlockEvidence = new Set<string>();
  const filesWithoutCaseSpans = new Set<string>();
  for (const key of repeated) {
    const file = fileOfBlock(key);
    const lines = index.blockLines.get(key) ?? 0;
    const blockEvidence = evidence.get(file);
    if (!blockEvidence) {
      // 语言无块语义查询：按总量计分（保持该语言原有信号强度），并明确记账为事实边界。
      filesWithoutBlockEvidence.add(file);
      assemblyLines += lines;
      continue;
    }
    if (!blockEvidence.caseBodyLines) filesWithoutCaseSpans.add(file);
    const startLine = index.blockStart.get(key) ?? 1;
    const semantics = classifyBlockSemantics({ startLine, endLine: startLine + blockWindow - 1 }, blockEvidence);
    if (semantics === "assertion") assertionLines += lines;
    else if (semantics === "case-body") caseBodyLines += lines;
    else if (semantics === "unclassified") unclassifiedLines += lines;
    else assemblyLines += lines;
  }
  return {
    assemblyLines, unclassifiedLines, assertionLines, caseBodyLines,
    denominatorLines: index.totalLinesAll,
    filesWithoutBlockEvidence: filesWithoutBlockEvidence.size,
    // 只统计"连块语义都没有"之外的文件：Go/Rust 已由上一个计数表达，避免重复记账。
    filesWithoutCaseSpans: [...filesWithoutCaseSpans].filter((file) => !filesWithoutBlockEvidence.has(file)).length,
  };
};

/** 块级 minhash 相似度聚合：**只排除可证明的断言块**（DRY/DAMP 平衡）。
 *  传空证据即回到"未分类、按总量计分"的旧口径（无证据时不冒充分类过）。
 *  返回「非断言重复行数 / 总行数」（校准 2026-08-08，2026-09-25 加块语义）。 */
export const codeSimilarityRatio = (files: readonly string[], blockWindow = 8, threshold = 0.6): number => {
  const buckets = codeSimilarityBuckets(files, new Map(), blockWindow, threshold);
  return buckets.denominatorLines === 0 ? 0 : chargedSimilarityLines(buckets) / buckets.denominatorLines;
};

/** 相似块涉及的文件级证据：每个文件的**计分**重复块行数（Top-3，降序）+ 块级定位。 */
export interface CodeSimilarityFileEvidence {
  readonly file: string;
  readonly repeatedLines: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly sample: string;
}

export const codeSimilarityEvidence = (
  files: readonly string[],
  blockWindow = 8,
  threshold = 0.6,
  evidence?: ReadonlyMap<string, BlockLineEvidence | undefined>,
): readonly CodeSimilarityFileEvidence[] => {
  const index = indexBlocks(files, blockWindow);
  const byFile = new Map<string, { repeatedLines: number; sampleKey?: string; sampleLines: number }>();
  for (const key of repeatedBlocksOf(index, threshold)) {
    const file = fileOfBlock(key);
    const blockEvidence = evidence?.get(file);
    if (evidence && blockEvidence) {
      const startLine = index.blockStart.get(key) ?? 1;
      // 证据只解释**计分**的那部分：否则读者无法把 Top-3 与分数对上。
      if (classifyBlockSemantics({ startLine, endLine: startLine + blockWindow - 1 }, blockEvidence) === "assertion") continue;
    }
    const entry = byFile.get(file) ?? { repeatedLines: 0, sampleLines: 0 };
    const keyLines = index.blockLines.get(key) ?? 0;
    entry.repeatedLines += keyLines;
    if (!entry.sampleKey || keyLines > entry.sampleLines) { entry.sampleKey = key; entry.sampleLines = keyLines; }
    byFile.set(file, entry);
  }
  return [...byFile.entries()]
    .map(([file, entry]) => ({
      file,
      repeatedLines: entry.repeatedLines,
      startLine: entry.sampleKey ? index.blockStart.get(entry.sampleKey) ?? 1 : 1,
      endLine: entry.sampleKey ? (index.blockStart.get(entry.sampleKey) ?? 1) + blockWindow - 1 : blockWindow,
      sample: entry.sampleKey ? index.blockSample.get(entry.sampleKey) ?? "" : "",
    }))
    .sort((a, b) => b.repeatedLines - a.repeatedLines)
    .slice(0, 3);
};

/**
 * 测试文件尺寸离散（校准 2026-08-08）：max 相对自然右尾 P95 的脱离度。
 * 测试文件的"大"与生产不同——完整覆盖矩阵（同一被测对象 30 个 it）合法，
 * 不应按 max/median 倍数误判（JsonFileStorage 502 行只是 P95 292 的 1.72 倍）。
 * 语义：仅当 max 超过本套测试文件 95 分位 2 倍（自然右尾的两倍）才提示异常。
 * 倍率常量 2.0 + 动态 P95，非绝对行数硬编码。样本过少（≤5）时 P95=max，值恒 1。
 *
 * 行数由调用方在同一遍统计循环里收集（`testBloatMetrics`），本函数不再自己读盘——
 * 同一文件在一次统计里被重复读取是审计 §4.2 记录的可测浪费。 */
const sizeDispersion = (sizes: readonly { readonly file: string; readonly lines: number }[]): { dispersion: number; maxFile?: string; maxLines: number; p95: number } => {
  const sorted = [...sizes].sort((a, b) => a.lines - b.lines);
  if (sorted.length <= 5) return { dispersion: 1, maxLines: sorted.at(-1)?.lines ?? 0, p95: sorted.at(-1)?.lines ?? 1 }; // 小样本无离散可言：P95=max → 脱离度恒 1
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[p95Index]?.lines ?? 1;
  const max = sorted[sorted.length - 1]!;
  return { dispersion: max.lines / Math.max(1, p95), maxFile: max.file, maxLines: max.lines, p95 };
};

/** git numstat 增长事实：ratio + 可测性依据（分母/分子是否真的被计数）。 */
export interface TestGrowthProbe {
  readonly ratio: number;
  readonly testDelta: number;
  readonly sourceDelta: number;
  readonly gitAvailable: boolean;
}

/** 近 N 提交测试行增量 / 生产行增量（git numstat——外部事实）。
 *  只计数 TS/JS 路径（旧口径原样保留），因此非 TS 项目 testDelta=sourceDelta=0：
 *  ratio 0 不是"测得 0"而是"不可测"——由调用方转成 UNAVAILABLE。 */
export const testGrowthProbe = (cwd: string, commits = 25): TestGrowthProbe => {
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
    return { ratio: sourceDelta === 0 ? 0 : testDelta / sourceDelta, testDelta, sourceDelta, gitAvailable: true };
  } catch {
    return { ratio: 0, testDelta: 0, sourceDelta: 0, gitAvailable: false };
  }
};

/** 便利导出：仅取值（不可测时 0）——判定可测性请用 testGrowthProbe。 */
/**
 * 便捷导出已删除（2026-09-25）：`listTestFiles` 只匹配 `.test.ts`，而生产入口是
 * `discoverProjectTestFiles()`（多语言、按 fileKind 总体），所以它只是**生产死代码**；
 * `testGrowthRatio(cwd, commits)` 把 `growthRatio` 压成一个 number，**掩盖了 availability**
 * ——不在 git 仓库时它返回 0，正是"把不可测序列化成 0"的旧反模式。需要 growth 判据的
 * 地方一律消费 `testBloatMetrics(...).parts`（带 availability 与 reason）。
 */

/** 可测性判定：返回缺省的 value + 不可测时的 reason。 */
const availability = (reason: TestBloatUnavailableReason | undefined, value: number): { readonly value?: number; readonly availability: TestBloatAvailability; readonly reason?: TestBloatUnavailableReason } =>
  reason === undefined
    ? { value, availability: "AVAILABLE" }
    : { availability: "UNAVAILABLE", reason };

export const testBloatMetrics = async (
  cwd: string,
  files: readonly string[],
  parser: ParserService,
  caseSpans?: BloatCaseSpanInput,
  /**
   * 已解析的项目语言形状（唯一读取权威 `application/projectShapes`）。
   * 调用方负责把声明错误上报（fail-closed）；此处只消费**已校验**的声明。
   * 缺省 ⇒ 全部走内置名单（与改动前逐位一致）。
   */
  shapes: ProjectShapes = {},
): Promise<TestBloatMetrics> => {
  let allLines = 0;
  let expectTotal = 0;
  let weakTotal = 0;
  let fixturePatternCompiled = false;
  let expectPatternCompiled = false;
  let weakPatternCompiled = false;
  // 披露（§6/Q1）：任一**语言绑定**测试文件使用了项目声明的弱断言名单 ⇒ `project`。
  // 缺失（undefined）表示本次没有可测的语言绑定文件——不写 `builtin` 冒充"已确认用内置"。
  let shapesSource: ShapesSource | undefined;
  const fixtureCalls = new Map<string, readonly string[]>();
  const fixtureFacts = new Map<string, readonly FixtureCallFact[]>();
  const weakByFile = new Map<string, { weak: number; expect: number }>();
  const weakSpansByFile = new Map<string, readonly BlockSpan[]>();
  const blockEvidenceByFile = new Map<string, BlockLineEvidence | undefined>();
  const caseBodyLinesByFile = caseBodyLineIndex(caseSpans);
  // 尺寸离散与"最大文件样本"都从这一遍读盘里取：`sizeDispersion` 与收尾的证据不再各读一次
  // （审计 §4.2：同一文件在一次统计里被读多次）。同一次运行内测试文件不会被写入，
  // 因此复用同一份 content 与再读一次的结果逐字相同。
  const fileSizes: { readonly file: string; readonly lines: number }[] = [];
  let widest: { readonly file: string; readonly lines: number; readonly sample: string } | undefined;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = totalLines(content);
    allLines += lines;
    fileSizes.push({ file, lines });
    // 与 `sizeDispersion` 同源（同一 files 顺序、同一排序稳定性 ⇒ 并列最大时取最后一个），
    // 所以这里的样本必然属于它算出的 maxFile。`split(/\r?\n/, 2)` 与先切后 slice(0,2) 等价。
    if (!widest || lines >= widest.lines) widest = { file, lines, sample: content.split(/\r?\n/, 2).join("\n") };
    blockEvidenceByFile.set(file, await blockLineEvidence(parser, file, caseBodyLinesByFile.get(file)));
    const fixture = await fixtureCallProbe(parser, file);
    fixtureCalls.set(file, fixture.texts);
    fixtureFacts.set(file, fixture.facts);
    if (fixture.availability === "AVAILABLE") fixturePatternCompiled = true;
    // 语言分派的弱断言探针：Java 用 JUnit 形状（名字权威派生），TS 系保持原形状。
    // 弱断言**名单**按语言取"项目声明（覆盖）或内置默认"（§6/Q1）。
    const weakProbe = weakAssertionPatternsFor(file, shapes);
    // 披露口径：见到第一个**语言绑定**文件即确定来源（builtin），见到任一项目声明则升级为
    // project（多语言下 `project` 优先——报告必须说明"至少有一种语言用了项目声明"）。
    if (weakProbe) shapesSource = shapesSource === "project" ? "project" : weakProbe.source;
    const expect = weakProbe ? await patternProbe(parser, file, weakProbe.patterns[0]) : { lines: 0, compiled: false, spans: [] };
    expectTotal += expect.lines;
    if (expect.compiled) expectPatternCompiled = true;
    const weak = weakProbe ? await patternProbe(parser, file, weakProbe.patterns[1]) : { lines: 0, compiled: false, spans: [] };
    weakTotal += weak.lines;
    if (weak.compiled) weakPatternCompiled = true;
    weakByFile.set(file, { weak: weak.lines, expect: expect.lines });
    weakSpansByFile.set(file, weak.spans);
  }
  const noFiles = files.length === 0;
  const fixtureLinesTotal = fixtureBoilerplateLines(fixtureCalls);
  const fixtureByFile = fixtureBoilerplateEvidence(fixtureFacts);
  const fixtureRatio = allLines === 0 ? 0 : fixtureLinesTotal / allLines;
  const similarity = codeSimilarityBuckets(files, blockEvidenceByFile, SIMILARITY_BLOCK_WINDOW, SIMILARITY_MINHASH_THRESHOLD);
  const ratio = (lines: number): number => similarity.denominatorLines === 0 ? 0 : lines / similarity.denominatorLines;
  const similarityRatio = ratio(chargedSimilarityLines(similarity));
  const similarityBuckets = {
    assemblyRatio: ratio(similarity.assemblyLines),
    unclassifiedRatio: ratio(similarity.unclassifiedLines),
    assertionRatio: ratio(similarity.assertionLines),
    caseBodyRatio: ratio(similarity.caseBodyLines),
    filesWithoutBlockEvidence: similarity.filesWithoutBlockEvidence,
    filesWithoutCaseSpans: similarity.filesWithoutCaseSpans,
    caseSpansAvailability: caseSpans?.availability ?? ("not_requested" as const),
  };
  const size = sizeDispersion(fileSizes);
  const dispersion = size.dispersion;
  const growth = testGrowthProbe(cwd);
  const weakRatio = expectTotal === 0 ? 0 : weakTotal / expectTotal;

  // 可测性判定（缺陷修复）：不可测 ≠ 0。codeSimilarity/sizeDispersion 语言中立，
  // 仅"没有测试文件"时不可测；三个语言绑定因子按模式编译/git 计数判定。
  const fixtureAvailability = availability(noFiles ? "no_test_files" : fixturePatternCompiled ? undefined : "language_not_supported_by_pattern", fixtureRatio);
  const similarityAvailability = availability(noFiles ? "no_test_files" : undefined, similarityRatio);
  const dispersionAvailability = availability(noFiles ? "no_test_files" : undefined, dispersion);
  const growthAvailability = availability(
    noFiles
      ? "no_test_files"
      : !growth.gitAvailable
        ? "not_a_git_repository"
        : growth.testDelta === 0 && growth.sourceDelta === 0
          ? "no_language_matched_history"
          : growth.sourceDelta === 0
            ? "no_production_delta"
            : undefined,
    growth.ratio,
  );
  const assertionAvailability = availability(
    noFiles
      ? "no_test_files"
      : expectPatternCompiled && weakPatternCompiled
        ? expectTotal === 0 ? "no_assertion_facts" : undefined
        : "language_not_supported_by_pattern",
    weakRatio,
  );

  // 触发因子的文件级证据（校准 2026-08-08）——与其他治理路径对齐：agent 能直接定位
  const evidence: TestBloatEvidence[] = [];
  if (fixtureAvailability.availability === "AVAILABLE" && fixtureRatio > 0.08) {
    for (const entry of fixtureByFile.slice(0, 3)) {
      evidence.push({
        factor: "fixtureBoilerplateRatio",
        file: normalizeRepositoryPath(entry.file, cwd),
        value: entry.repeatedLines,
        detail: `fixture 调用 ${entry.repeatedLines} 行`,
        startLine: entry.startLine,
        endLine: entry.endLine,
        sample: entry.sample,
      });
    }
  }
  if (similarityAvailability.availability === "AVAILABLE" && similarityRatio > SIMILARITY_THRESHOLD) {
    for (const { file, repeatedLines, startLine, endLine, sample } of codeSimilarityEvidence(files, SIMILARITY_BLOCK_WINDOW, SIMILARITY_MINHASH_THRESHOLD, blockEvidenceByFile)) {
      evidence.push({
        factor: "codeSimilarityRatio",
        file: normalizeRepositoryPath(file, cwd),
        value: repeatedLines,
        detail: `与其它文件共享相似块 ${repeatedLines} 行`,
        startLine,
        endLine,
        sample,
      });
    }
  }
  if (dispersionAvailability.availability === "AVAILABLE" && dispersion > 2 && size.maxFile) {
    evidence.push({
      factor: "sizeDispersion",
      file: normalizeRepositoryPath(size.maxFile, cwd),
      value: size.maxLines,
      detail: `${size.maxLines} 行（本套 P95=${size.p95}）`,
      startLine: 1,
      endLine: size.maxLines,
      sample: widest?.sample ?? "",
    });
  }
  if (assertionAvailability.availability === "AVAILABLE" && weakRatio > 0.03) {
    for (const [file, { weak, expect }] of [...weakByFile.entries()].filter(([, v]) => v.weak > 0).sort((a, b) => b[1].weak - a[1].weak).slice(0, 3)) {
      const span = weakSpansByFile.get(file)?.[0];
      evidence.push({
        factor: "weakAssertionRatio",
        file: normalizeRepositoryPath(file, cwd),
        value: weak,
        detail: `弱断言 ${weak}/${expect} 处`,
        startLine: span?.startLine ?? 1,
        endLine: span?.endLine ?? 1,
        sample: span?.sample ?? "",
      });
    }
  }

  const part = (
    name: TestBloatFactor,
    probe: { readonly value?: number; readonly availability: TestBloatAvailability; readonly reason?: TestBloatUnavailableReason },
    threshold: number,
    weight: number,
    suggestion: string,
  ): TestBloatPart => ({
    name,
    ...probe,
    threshold,
    weight,
    contribution: probe.value === undefined ? 0 : weight * Math.min(1, probe.value / threshold),
    suggestion,
  });
  const weighted: readonly TestBloatPart[] = [
    part("fixtureBoilerplateRatio", fixtureAvailability, 0.08, TEST_BLOAT_WEIGHTS[0], "提取共享测试工具（fixture builder / temp-dir helper），消除各测试文件重复的 setup/teardown 样板"),
    part("codeSimilarityRatio", similarityAvailability, SIMILARITY_THRESHOLD, TEST_BLOAT_WEIGHTS[1], "高相似测试块聚类：抽取公共 fixture 工厂并参数化差异（路径/时间戳/随机值）"),
    part("sizeDispersion", dispersionAvailability, 2, TEST_BLOAT_WEIGHTS[2], "测试文件允许完整覆盖矩阵（同主题多用例）；仅当 max 超过本套测试文件 P95 的 2 倍（自然右尾两倍）才需检查是否多个无关主题挤在一个文件"),
    part("growthRatio", growthAvailability, 1.5, TEST_BLOAT_WEIGHTS[3], "测试行数增长持续快于实现：检查是否每处改动都叠加新用例，考虑表驱动/参数化合并重复"),
    part("weakAssertionRatio", assertionAvailability, 0.03, TEST_BLOAT_WEIGHTS[4], "低信息量断言（存在性/布尔断言）占比偏高：改为断言具体值与错误类型，让失败可定位"),
  ];
  // 重归一化：UNAVAILABLE 因子（contribution 0 且 value 缺省）不进分母。
  // score = Σ contribution / Σ availableWeight；全部可用时 Σw = 1.0，与旧公式逐位一致
  // （此分支避免浮点求和 0.3+0.3+0.2+0.1+0.1 的 ULP 漂移改动 TS/JS 分数）。
  const availableWeight = weighted.reduce((sum, part) => sum + (part.availability === "AVAILABLE" ? part.weight : 0), 0);
  const contributionSum = weighted.reduce((sum, part) => sum + part.contribution, 0);
  const allAvailable = weighted.every((part) => part.availability === "AVAILABLE");
  const score = availableWeight === 0 ? 0 : allAvailable ? contributionSum : contributionSum / availableWeight;
  return {
    ...(fixtureAvailability.value === undefined ? {} : { fixtureBoilerplateRatio: fixtureAvailability.value }),
    ...(similarityAvailability.value === undefined ? {} : { codeSimilarityRatio: similarityAvailability.value }),
    ...(dispersionAvailability.value === undefined ? {} : { sizeDispersion: dispersionAvailability.value }),
    ...(growthAvailability.value === undefined ? {} : { growthRatio: growthAvailability.value }),
    ...(assertionAvailability.value === undefined ? {} : { weakAssertionRatio: assertionAvailability.value }),
    // 披露只在**弱断言可测**时出现：不可测时"用哪份名单"没有事实（不写 `builtin` 冒充已确认）。
    ...(assertionAvailability.availability === "AVAILABLE" && shapesSource !== undefined ? { weakAssertionShapesSource: shapesSource } : {}),
    score,
    availableWeight,
    triggered: score > 0.5,
    parts: weighted,
    evidence,
    similarityBuckets,
  };
};

