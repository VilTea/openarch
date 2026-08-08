// packages/core/src/application/changeSurface.ts
/**
 * 变更面冲击编排（规格 2026-08-03-change-surface-impact.md §3）。
 *
 * 把「变更符号 → 消费者」接成 C_push 计算链：
 *   semanticProfiles（变更符号）→ symbolUseReports（符号消费者，TS=编译器/其余=LSP）
 *   → 过滤变更文件自身 → computeChangeSurfaceImpact。
 *
 * 诚实降级（§3.3，无兜底）：语言 report 缺失或 state.availability === "unavailable"
 * （工具链不可用/Provider 失败）时，**不产出该语言任何 C_push 数值**——不退回
 * 文件级反向图计算一个像 C_push 的值（那会高估消费者面、误导 agent）。报告列出
 * 不可用语言与原因；I_push（结构性基线）照常输出，二者互不替代。
 * demand 模式的 partial 覆盖（coverage=partial）是正常证据形态，照常计算。
 */
import type { SemanticFileProfile } from "./semanticDiff";
import type { SymbolUseReport } from "../symbol-use/types";
import { computeChangeSurfaceImpact, type ChangeSurfaceResult } from "../domain/changeSurfaceImpact";
import { layerWeightOf, type PathClass } from "./pathClass";
import { findLanguageForFile } from "../adapter/parser/LanguageRegistry";
import { toAbsolute, toRelative } from "../infra/paths";

export interface FileChangeSurface {
  readonly file: string;
  readonly language: string;
  /** 文件级静态上界消费者数（符号消费者 ⊆ 上界，规格 §3.4）。 */
  readonly staticBound: number;
  readonly result: ChangeSurfaceResult;
}

export interface ChangeSurfaceUnavailableLanguage {
  readonly language: string;
  readonly reason: string;
}

export interface ChangeSurfaceCollection {
  readonly availability: "available" | "unavailable";
  readonly surfaces: readonly FileChangeSurface[];
  readonly unavailableLanguages: readonly ChangeSurfaceUnavailableLanguage[];
}

export interface ChangeSurfaceForProfilesInput {
  readonly profiles: readonly SemanticFileProfile[];
  readonly symbolUseReports?: readonly SymbolUseReport[];
  readonly pathClasses: readonly PathClass[];
  /** 文件级反向图（静态上界，规格 §3.4）；key/value 为绝对路径。 */
  readonly reverseEdges: ReadonlyMap<string, readonly string[]>;
}

/** Import 变更属于依赖图维度（I_push 已覆盖），不是被修改符号的消费者冲击。 */
const declarationChanges = (profile: SemanticFileProfile) =>
  profile.changes.filter((change) => !change.anchor.startsWith("import:"));

/**
 * 引用证据可靠性（规格 2026-08）：优先用结构化信号 `incompleteReferences`
 * （LSP 采集不完整的直接证据），不再匹配文案；非 LSP report（无结构化信号）
 * 时回退到风险文案模式匹配（incomplete / not complete）。demand 模式的
 * partial 覆盖是正常形态（TS 编译器确定性引用），不因 partial 判不可靠。
 */
const UNRELIABLE_REFERENCE_PATTERNS: readonly RegExp[] = [/incomplete/i, /not complete/i];

const referencesReliable = (report: SymbolUseReport): boolean => {
  const incomplete = report.state.coverage.incompleteReferences;
  if (incomplete !== undefined) return !incomplete;
  return report.state.coverage.repositoryReferences !== "unavailable"
    && !UNRELIABLE_REFERENCE_PATTERNS.some((pattern) => pattern.test(report.state.reason ?? ""));
};

const leafName = (anchor: string): string => anchor.split(".").at(-1) ?? anchor;

/** 文件级静态上界：反向图消费者（去重、排除自身），规格 §3.4。 */
const staticConsumersFor = (file: string, reverseEdges: ReadonlyMap<string, readonly string[]>): readonly string[] =>
  [...new Set((reverseEdges.get(toAbsolute(file)) ?? []).map(toRelative).filter((candidate) => candidate !== file))].sort();

const reportLanguage = (file: string): string => findLanguageForFile(file)?.id ?? "unknown";

/** 符号证据：按文件+叶子名配对消费者（provider 契约是叶子名，规格 §5.1），排除变更文件自身。 */
const symbolConsumersByAnchor = (
  profile: SemanticFileProfile,
  report: SymbolUseReport,
): ReadonlyMap<string, readonly string[]> => {
  const consumersByAnchor = new Map<string, string[]>();
  const factsByLeaf = new Map<string, string[]>();
  for (const fact of report.facts) {
    if (fact.declaration.file !== profile.file) continue;
    const existing = factsByLeaf.get(fact.declaration.name) ?? [];
    factsByLeaf.set(fact.declaration.name, existing.concat(fact.repositoryReferences
      .map((reference) => reference.file)
      .filter((file) => file !== profile.file)));
  }
  for (const change of declarationChanges(profile)) {
    const name = leafName(change.anchor);
    // 文件级兜底（--change-override 的 manual:file/file 无真实符号名，校准
    // 2026-08-06）——合并该文件全部 facts 的消费者；否则 leafName 不匹配任何
    // fact 名，符号级确认恒为 0（references 已查但锚定丢失）。
    const consumers = name === "file" || name.startsWith("manual:")
      ? [...new Set([...factsByLeaf.values()].flat())]
      : (factsByLeaf.get(name) ?? []);
    consumersByAnchor.set(change.anchor, [...new Set(consumers)].sort());
  }
  return consumersByAnchor;
};

/**
 * 逐变更文件计算 C_push（规格 §3.3/§3.4）：
 * - 静态上界为空 → provenance = "static-bound-empty" 的 0 消费者（逻辑必然，无需 LSP）；
 * - 上界非空 + report 缺失/unavailable/引用不完整 → 不输出数值，汇入 unavailableLanguages；
 * - 上界非空 + 符号证据可靠 → provenance = "symbol"，并列 staticBound（M≤N 校验）。
 */
export const computeChangeSurfaceForProfiles = (input: ChangeSurfaceForProfilesInput): ChangeSurfaceCollection => {
  const reports = input.symbolUseReports ?? [];
  const surfaces: FileChangeSurface[] = [];
  const unavailableLanguages = new Map<string, string>();
  for (const profile of input.profiles) {
    const changes = declarationChanges(profile);
    if (changes.length === 0) continue;
    const language = reportLanguage(profile.file);
    const staticConsumers = staticConsumersFor(profile.file, input.reverseEdges);
    if (staticConsumers.length === 0) {
      surfaces.push({
        file: profile.file,
        language,
        staticBound: 0,
        result: computeChangeSurfaceImpact({
          provenance: "static-bound-empty",
          changes,
          consumersByAnchor: new Map(changes.map((change) => [change.anchor, []])),
          layerWeightOf: (file) => layerWeightOf(file, input.pathClasses),
        }),
      });
      continue;
    }
    const report = reports.find((candidate) => candidate.origin.language === language);
    if (!report || report.state.availability === "unavailable") {
      const reason = !report
        ? `${language} symbol-use report missing (toolchain unavailable)`
        : (report.state.reason ?? `${language} symbol-use unavailable`);
      unavailableLanguages.set(language, reason);
      continue;
    }
    const consumersByAnchor = symbolConsumersByAnchor(profile, report);
    // 交叉校验（校准 2026-08-05：gopls demand 只确认测试引用，生产 15 个调用者
    // 0 确认——符号级 6 与静态上界 26 交集为空）：符号级非空但与静态上界完全不
    // 重叠，是"跨包消费者未被 LSP 确认"的强信号——判定不可靠，不输出 C_push。
    const symbolFiles = [...new Set([...consumersByAnchor.values()].flat())];
    const crossPackageMissed = symbolFiles.length > 0 && staticConsumers.length > 0
      && symbolFiles.every((file) => !staticConsumers.includes(file));
    if (crossPackageMissed) {
      unavailableLanguages.set(language, `LSP 引用与静态上界无交集（${language}）：符号级 ${symbolFiles.length} 个消费者与静态 ${staticConsumers.length} 个上界完全不重叠，跨包消费者未被确认`);
      continue;
    }
    // 引用采集不完整（demand 未评估全量 / LSP 超时）但已有确认消费者 → 输出
    // 已确认的符号级消费者（单项目符号级刚需，校准 2026-08-06：Python check
    // 确认 main.py 但被 incomplete 整体吞掉）；风险标注由报告层携带，agent 可见。
    // 采集不完整且 0 确认消费者 → 无证据可输出，fail-closed。
    if (!referencesReliable(report) && symbolFiles.length === 0) {
      unavailableLanguages.set(language, `LSP 引用采集不完整且无确认消费者（${language}）：${report.state.reason ?? "incomplete references"}`);
      continue;
    }
    surfaces.push({
      file: profile.file,
      language,
      staticBound: staticConsumers.length,
      result: computeChangeSurfaceImpact({
        provenance: "symbol",
        changes,
        consumersByAnchor,
        // 静态上界非空但符号级 0 消费者 → 待确认（unconfirmed），不是结论 0（规格 §3.6）
        unconfirmedAnchors: declarationChanges(profile)
          .filter((change) => consumersByAnchor.get(change.anchor)?.length === 0)
          .map((change) => change.anchor),
        layerWeightOf: (file) => layerWeightOf(file, input.pathClasses),
      }),
    });
  }
  return {
    availability: surfaces.length > 0 ? "available" : "unavailable",
    surfaces,
    unavailableLanguages: [...unavailableLanguages.entries()].map(([language, reason]) => ({ language, reason })),
  };
};
