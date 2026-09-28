// 测试治理的跨语言合同：core 只认识标准 finding 和文件分类，不认识具体框架语法。
import { minimatch } from "minimatch";
import { isAbsolute, relative, resolve } from "node:path";
import type { TestModuleAssociation } from "./testAssociations";
import { toAbsolute, toPosixPath } from "../infra/paths";

/** Single runtime/type authority for file participation roles. */
export const FILE_KINDS = ["production", "test", "generated", "auxiliary"] as const;
export type FileKind = typeof FILE_KINDS[number];
export interface FileKindRule { readonly pattern: string; readonly kind: FileKind; }
export type TestFindingConfidence = "confirmed" | "high" | "medium" | "low";
export type TestPolicyAction = "block" | "warn" | "review";

export const isFileKind = (value: unknown): value is FileKind =>
  typeof value === "string" && (FILE_KINDS as readonly string[]).includes(value);

export const isFileKindRule = (value: unknown): value is FileKindRule => {
  if (!value || typeof value !== "object") return false;
  const rule = value as { pattern?: unknown; kind?: unknown };
  return typeof rule.pattern === "string" && isFileKind(rule.kind);
};

/**
 * 保守默认分类。项目可在 scan 的 fileKindClassifier 中替换，不把目录惯例固化为产品策略。
 *
 * **契约纪律（改动本函数语义前必读）**：`fileKind` 是**持久化**事实（baseline index），
 * 决定 `test-governance` / `production-governance` population 的成员；而唯一能表达
 * "分类语义已变"的身份是 `createAnalysisScope()` 的 fingerprint（它只含
 * `languages + extensions + fileKindRules`），该身份同时是 gate 的 baseline 兼容判据。
 * 因此：
 * - 能表达为**路径规则**的语义（如 Java 布局的 `src/main/java`）应当由
 *   `readProjectFileKindRules()` 以推导规则注入，从而自动进入 fingerprint；
 * - 无法表达为规则的改动（如给 `*_test.go` 之类后缀换判据）必须**递增
 *   scope 版本前缀**，否则旧 baseline 的 `fileKind` 会静默保持旧语义，而
 *   `status` 仍报 scope compatible、gate 仍放行——事实与身份不一致。
 *
 * 判定顺序也依赖"规则优先"这一事实：`classifyFileKindWithPolicy` 先跑规则，本函数只是兜底。
 */
export const classifyFileKind = (filePath: string): FileKind => {
  const path = toPosixPath(filePath).toLowerCase();
  if (path.includes("/dist/") || path.includes("/generated/") || path.endsWith(".d.ts")) return "generated";
  if (/(^|\/)(?:__tests__|tests?)(?:\/|$)/.test(path) || /\.(?:test|spec)\.[^/]+$/.test(path) || /_test\.go$/.test(path) || /(?:test|tests|it)\.java$/.test(path)) return "test";
  return "production";
};

const normalizeForPolicy = (filePath: string, projectRoot?: string): string => {
  const normalized = toPosixPath(filePath);
  if (!projectRoot || !isAbsolute(filePath)) return normalized;
  return relative(resolve(projectRoot), resolve(filePath)).replace(/\\/g, "/");
};

/** 项目规则在默认分类之前匹配；规则按项目根相对路径解释。 */
export const classifyFileKindWithPolicy = (
  filePath: string,
  rules: readonly FileKindRule[] = [],
  options: { readonly projectRoot?: string } = {},
): FileKind => {
  const policyPath = normalizeForPolicy(filePath, options.projectRoot).toLowerCase();
  return rules.find((rule) => minimatch(policyPath, toPosixPath(rule.pattern).toLowerCase()))?.kind ?? classifyFileKind(policyPath);
};

/**
 * provider 或项目脚本已经识别、但尚未被项目策略裁决的事实。
 *
 * `kind` 是**跨语言合同**的开放字符串（不是枚举，故新增 kind 不破坏类型），
 * 也是 `TestPolicy.rules` 的键之一（`rules[kind] ?? rules[ruleId] ?? "review"`），
 * 所以新增 kind 是**策略语义变更**，必须在 CHANGELOG 与 skill 文档里写明迁移口径。
 * 目前的标准 kind：
 * - `missing_assertion`：**有语句但**未识别出断言/验证；
 * - `empty_test_body`：用例体**没有任何语句**（D-G6，2026-09-25 新增）。
 *   与 `missing_assertion` 分开是因为两者含义不同——空体在夹具类语料里多是被测对象，
 *   而非"忘记断言"。迁移语义：按 `missing_assertion` 配置的规则不再命中空体。
 *   能力边界：只有能证明"体里零语句"的 provider 才会发出本 kind
 *   （Java 已支持；Python 无法表达空体——`pass` 本身就是语句；Go 不设该策略）。
 * - `unapproved_skip`：跳过/禁用用例；
 * - `focused_test`：`.only` 类聚焦用例（TS 系）。
 */
export interface TestFinding {
  readonly ruleId: string;
  readonly kind: string;
  readonly file: string;
  readonly evidence: readonly string[];
  readonly confidence: TestFindingConfidence;
  readonly source: string;
  readonly testName?: string;
  readonly line?: number;
  /**
   * D-G18（2026-09-25 项目所有者批准）：本 finding 来自**未入 canonical baseline** 的测试文件。
   *
   * provider 采集自 D-G18 起以**实时发现**的测试文件为范围（与 `TEST_BLOAT` 同一口径），
   * 因此 finding 可能不再有 baseline 对账对象。缺省即旧语义（该文件已在 baseline 内），
   * 所以这是**非破坏追加**：老 finding 不带该键，消费方不必改。
   * 判据只有一个权威入口（`unbaselinedOf` 对 canonical baseline 条目的比较），
   * 不在 provider 或渲染层再写一份"看起来差不多"的过滤。
   */
  readonly unbaselined?: true;
}

/** 脚本不得伪造 source；执行引擎从规则文件名注入。 */
export type TestFindingInput = Omit<TestFinding, "source">;

/**
 * 「新增但未入 baseline 的测试文件」的**唯一判据**（校准 2026-09-25，D-G18 后下沉到 domain）。
 * `openarch test` 一直以来只在自身报告里提示它，而 `check` 不提示 —— 不主动跑 test
 * 的使用方就会漏掉"测试文件未纳入基线"。抽出这个纯函数让两条路径共用同一判断，
 * 而不是在 CLI 层再写一份"看起来差不多"的过滤（认知点原则：一个概念一个入口）。
 *
 * D-G18 后它同时是 `TestFinding.unbaselined` 的来源标记判据与 provider 覆盖口径的判据：
 * provider 采集范围改为实时发现集合后，"这条 finding 有没有 baseline 对账对象"
 * 只有这一个答案。放在 domain 是因为它是纯粹的集合事实、不依赖任何 service；
 * `application/testGovernance` 仍转出同一入口，公开 API 不变。
 */
export const unbaselinedOf = (discovered: readonly string[], canonicalTestPaths: Iterable<string>): readonly string[] => {
  const baseline = new Set([...canonicalTestPaths].map(toAbsolute));
  return discovered.filter((path) => !baseline.has(toAbsolute(path)));
};

export interface TestCaseMetric {
  readonly name: string;
  readonly loc: number;
  readonly assertionCount: number;
  readonly mockCount: number;
  readonly statuses: readonly string[];
  /** Provider-observed weighted control flow in the recognised test body; absent means unavailable, never zero by fallback. */
  readonly testBodyControlFlow?: number;
}

/** Provider-confirmed source range for one recognised test case; scripts consume it without re-parsing framework syntax. */
export interface TestCaseSpan {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly statuses: readonly string[];
}

/** A test-case span with the provider and file that established it. */
export interface TestCaseSpanFact extends TestCaseSpan {
  readonly file: string;
  readonly providerId: string;
}

/** baseline 的可选、版本化测试扩展。具体框架字段必须留在 provider 内部。 */
export interface TestMetrics {
  readonly schemaVersion: "1" | "2" | "3" | "4";
  readonly providerId: string;
  readonly tests: readonly TestCaseMetric[];
  readonly findings?: readonly TestFinding[];
  /** v3/v4 S2 module associations; v4 may add narrow medium symbol-call evidence. */
  readonly moduleAssociations?: readonly TestModuleAssociation[];
}

/** 项目策略是 finding → 动作的唯一映射点；provider 和脚本不得携带 severity。 */
export interface TestPolicy {
  readonly rules: Readonly<Record<string, TestPolicyAction>>;
  readonly exemptions?: readonly TestFindingExemption[];
}

export interface TestFindingExemption {
  readonly ruleId: string;
  readonly reason: string;
  readonly owner: string;
  readonly expires: string;
  readonly file?: string;
}

export interface TestPolicyResult {
  readonly verdict: "PASS" | "WARN" | "BLOCK";
  readonly triggered: readonly { finding: TestFinding; level: Exclude<TestPolicyAction, "review"> }[];
  readonly exempted: readonly TestFinding[];
}

const exemptionApplies = (finding: TestFinding, exemption: TestFindingExemption, now: Date): boolean =>
  exemption.ruleId === finding.ruleId
  && (!exemption.file || exemption.file === finding.file)
  && Number.isFinite(Date.parse(exemption.expires))
  && Date.parse(exemption.expires) > now.getTime();

/** 纯策略裁决：未配置的 finding 保留给 review，不静默升级为 gate。 */
export const evaluateTestPolicy = (findings: readonly TestFinding[], policy: TestPolicy, now = new Date()): TestPolicyResult => {
  const triggered: Array<{ finding: TestFinding; level: "block" | "warn" }> = [];
  const exempted: TestFinding[] = [];
  for (const finding of findings) {
    if ((policy.exemptions ?? []).some((exemption) => exemptionApplies(finding, exemption, now))) {
      exempted.push(finding);
      continue;
    }
    const action = policy.rules[finding.kind] ?? policy.rules[finding.ruleId] ?? "review";
    if (action !== "review") triggered.push({ finding, level: action });
  }
  const verdict = triggered.some((entry) => entry.level === "block") ? "BLOCK"
    : triggered.some((entry) => entry.level === "warn") ? "WARN" : "PASS";
  return { verdict, triggered, exempted };
};
