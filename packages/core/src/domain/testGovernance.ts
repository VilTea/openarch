// 测试治理的跨语言合同：core 只认识标准 finding 和文件分类，不认识具体框架语法。
import { minimatch } from "minimatch";
import { isAbsolute, relative, resolve } from "node:path";
import type { TestModuleAssociation } from "./testAssociations";

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

/** 保守默认分类。项目可在 scan 的 fileKindClassifier 中替换，不把目录惯例固化为产品策略。 */
export const classifyFileKind = (filePath: string): FileKind => {
  const path = filePath.replace(/\\/g, "/").toLowerCase();
  if (path.includes("/dist/") || path.includes("/generated/") || path.endsWith(".d.ts")) return "generated";
  if (/(^|\/)(?:__tests__|tests?)(?:\/|$)/.test(path) || /\.(?:test|spec)\.[^/]+$/.test(path) || /_test\.go$/.test(path) || /(?:test|tests|it)\.java$/.test(path)) return "test";
  return "production";
};

const normalizeForPolicy = (filePath: string, projectRoot?: string): string => {
  const normalized = filePath.replace(/\\/g, "/");
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
  return rules.find((rule) => minimatch(policyPath, rule.pattern.replace(/\\/g, "/").toLowerCase()))?.kind ?? classifyFileKind(policyPath);
};

/** provider 或项目脚本已经识别、但尚未被项目策略裁决的事实。 */
export interface TestFinding {
  readonly ruleId: string;
  readonly kind: string;
  readonly file: string;
  readonly evidence: readonly string[];
  readonly confidence: TestFindingConfidence;
  readonly source: string;
  readonly testName?: string;
  readonly line?: number;
}

/** 脚本不得伪造 source；执行引擎从规则文件名注入。 */
export type TestFindingInput = Omit<TestFinding, "source">;

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
