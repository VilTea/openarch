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
 *
 * 证据缺口（缺陷 B3 修复 2026-09-30）：符号/可见性证据不可用时，缺口必须落到
 * **受影响的文件**，而不能只停在一个语言级投影上；静态上界为空而跳过符号查询的
 * 文件同样留下显式缺口记录（此前 `static-bound-empty` 完全静默，看起来像「已确证
 * 0 消费者」）。`symbolEvidenceDossiersForProfiles` 是这一判定的**唯一**权威实现，
 * `computeChangeSurfaceForProfiles`（C_push 编排）与 impactPlan（agent 面计划）都从
 * 它派生；任何「provider 是否可用」的判断都不得在别处重写（认知点原则）。
 */
import type { SemanticFileProfile } from "./semanticDiff";
import type { SymbolUseReport } from "../symbol-use/types";
import {
  computeChangeSurfaceImpact,
  type ChangeSurfaceInput,
  type ChangeSurfaceResult,
} from "../domain/changeSurfaceImpact";
import { layerWeightOf, type PathClass } from "./pathClass";
import { findLanguageForFile } from "../adapter/parser/LanguageRegistry";
import { toAbsolute, toRelative } from "../infra/paths";

/** 变更面贡献所需的变更事实（锚点 + 类别），不依赖 profile 的具体形态。 */
type SurfaceChange = ChangeSurfaceInput["changes"][number];

export interface FileChangeSurface {
  readonly file: string;
  readonly language: string;
  /** 文件级静态上界消费者数（符号消费者 ⊆ 上界，规格 §3.4）。 */
  readonly staticBound: number;
  readonly result: ChangeSurfaceResult;
}

/**
 * 证据缺口成因（权威分类）：
 * - `provider-unavailable`：符号/可见性证据本身不可用（report 缺失、工具链不可用、
 *   引用采集不完整且无确认消费者、符号级与静态上界零交集）——该文件**不产出任何
 *   C_push 数值**；
 * - `static-bound-empty`：静态上界为空而**跳过**符号查询——C_push=0 是结构性结论，
 *   但符号/可见性证据**未查询**，必须显式记账，不能被读成「符号级已确证 0 消费者」。
 */
export type ChangeSurfaceEvidenceGapKind = "provider-unavailable" | "static-bound-empty";

/**
 * 逐文件的符号/可见性证据缺口（唯一权威定义）。受影响文件、语言、声明锚点与
 * 工具链原因都在这里一次生成；报告层只渲染，不重新判定 provider 是否可用。
 */
export interface ChangeSurfaceEvidenceGap {
  /** 受影响变更文件（仓库相对路径）。 */
  readonly file: string;
  readonly language: string;
  readonly kind: ChangeSurfaceEvidenceGapKind;
  /** 受影响声明锚点（该文件内需要符号证据的变更声明）。 */
  readonly anchors: readonly string[];
  /** 工具链/provider 原因（权威文案；`static-bound-empty` 时为「未查询」的结构性原因）。 */
  readonly reason: string;
}

/**
 * 语言级不可用事实。B3 修复：**附加受影响文件**，而不是只留一个语言标签；
 * 既有 `{language, reason}` 字段保持原义，语言键消费方（如 CLI 渲染层）无需改动。
 */
export interface ChangeSurfaceUnavailableLanguage {
  readonly language: string;
  readonly reason: string;
  /** 该语言下符号证据不可用的受影响变更文件（仓库相对路径，profile 顺序，去重）。 */
  readonly files: readonly string[];
}

/** 逐变更文件的符号/可见性证据形态（权威判定结果）。 */
export interface SymbolEvidenceDossier {
  /** 变更文件（仓库相对路径）。 */
  readonly file: string;
  readonly language: string;
  /** 排除 import 锚点后的变更声明（C_push 的输入单位）。 */
  readonly changes: readonly SurfaceChange[];
  /** 变更声明锚点（顺序与 changes 一致）。 */
  readonly anchors: readonly string[];
  /** 文件级静态上界消费者（规格 §3.4）。 */
  readonly staticConsumers: readonly string[];
  /** 证据形态。 */
  readonly evidence: "symbol" | "static-bound-empty" | "provider-unavailable";
  /**
   * 符号级消费者；仅 `evidence === "symbol"` 时存在。不可用时**不给空 map**——
   * 空 map 会被下游读成「已确认 0 消费者」，正是本缺陷要消除的误导。
   */
  readonly consumersByAnchor?: ReadonlyMap<string, readonly string[]>;
  /** 证据缺口；证据真正可用（`evidence === "symbol"`）时不存在，不得凭空发明。 */
  readonly gap?: ChangeSurfaceEvidenceGap;
}

export interface SymbolEvidenceInput {
  readonly profiles: readonly SemanticFileProfile[];
  readonly symbolUseReports?: readonly SymbolUseReport[];
  /** 文件级反向图（静态上界，规格 §3.4）；key/value 为绝对路径。 */
  readonly reverseEdges: ReadonlyMap<string, readonly string[]>;
}

export interface ChangeSurfaceCollection {
  readonly availability: "available" | "unavailable";
  readonly surfaces: readonly FileChangeSurface[];
  /** 语言键兼容投影（含受影响文件）。 */
  readonly unavailableLanguages: readonly ChangeSurfaceUnavailableLanguage[];
  /**
   * 逐文件证据缺口（权威事实，含 `static-bound-empty` 的结构性未查询）。
   * 只读报告事实：不参与 I_push / deltaI / CRL / gate / 退出码。
   */
  readonly symbolEvidenceGaps: readonly ChangeSurfaceEvidenceGap[];
}

export interface ChangeSurfaceForProfilesInput extends SymbolEvidenceInput {
  readonly pathClasses: readonly PathClass[];
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
 * **唯一权威判定**：逐变更文件的符号/可见性证据形态（规格 §3.3/§3.4）。
 *
 * - 静态上界为空 → `static-bound-empty`：C_push 逻辑必然 0，但符号证据**未查询**，
 *   缺口照实记账（缺陷 B3 第二处：此前该分支完全静默）；
 * - 上界非空 + report 缺失/unavailable/引用不完整无确认/符号级与静态上界零交集
 *   → `provider-unavailable`：缺口带工具链原因，附受影响文件；
 * - 上界非空 + 符号证据可靠 → `symbol`：消费者就绪，`gap` 不存在。
 *
 * C_push 编排与 impactPlan 都消费这一份事实；不得在别处重写 provider 可用性判断。
 */
export const symbolEvidenceDossiersForProfiles = (input: SymbolEvidenceInput): readonly SymbolEvidenceDossier[] => {
  const reports = input.symbolUseReports ?? [];
  const dossiers: SymbolEvidenceDossier[] = [];
  for (const profile of input.profiles) {
    const changes = declarationChanges(profile);
    if (changes.length === 0) continue;
    const language = reportLanguage(profile.file);
    const anchors = changes.map((change) => change.anchor);
    const staticConsumers = staticConsumersFor(profile.file, input.reverseEdges);
    const base = { file: profile.file, language, changes, anchors, staticConsumers };
    if (staticConsumers.length === 0) {
      dossiers.push({
        ...base,
        evidence: "static-bound-empty",
        consumersByAnchor: new Map(changes.map((change) => [change.anchor, [] as readonly string[]])),
        gap: {
          file: profile.file,
          language,
          kind: "static-bound-empty",
          anchors,
          reason: `${language} 符号/可见性证据未查询：静态上界为空（无反向依赖消费者），0 消费者为结构性结论，非符号级确证`,
        },
      });
      continue;
    }
    const report = reports.find((candidate) => candidate.origin.language === language);
    if (!report || report.state.availability === "unavailable") {
      const reason = !report
        ? `${language} symbol-use report missing (toolchain unavailable)`
        : (report.state.reason ?? `${language} symbol-use unavailable`);
      dossiers.push({ ...base, evidence: "provider-unavailable", gap: { file: profile.file, language, kind: "provider-unavailable", anchors, reason } });
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
      dossiers.push({
        ...base,
        evidence: "provider-unavailable",
        gap: {
          file: profile.file, language, kind: "provider-unavailable", anchors,
          reason: `LSP 引用与静态上界无交集（${language}）：符号级 ${symbolFiles.length} 个消费者与静态 ${staticConsumers.length} 个上界完全不重叠，跨包消费者未被确认`,
        },
      });
      continue;
    }
    // 引用采集不完整（demand 未评估全量 / LSP 超时）但已有确认消费者 → 输出
    // 已确认的符号级消费者（单项目符号级刚需，校准 2026-08-06：Python check
    // 确认 main.py 但被 incomplete 整体吞掉）；风险标注由报告层携带，agent 可见。
    // 采集不完整且 0 确认消费者 → 无证据可输出，fail-closed。
    if (!referencesReliable(report) && symbolFiles.length === 0) {
      dossiers.push({
        ...base,
        evidence: "provider-unavailable",
        gap: {
          file: profile.file, language, kind: "provider-unavailable", anchors,
          reason: `LSP 引用采集不完整且无确认消费者（${language}）：${report.state.reason ?? "incomplete references"}`,
        },
      });
      continue;
    }
    dossiers.push({ ...base, evidence: "symbol", consumersByAnchor });
  }
  return dossiers;
};

/**
 * 语言键投影：按 profile 顺序聚合，原因文案沿用「后到覆盖」（与修复前 Map.set
 * 语义一致），文件列表累积去重——语言级事实不再丢失受影响文件。
 */
const unavailableLanguagesFromGaps = (
  gaps: readonly ChangeSurfaceEvidenceGap[],
): readonly ChangeSurfaceUnavailableLanguage[] => {
  const byLanguage = new Map<string, { language: string; reason: string; files: string[] }>();
  for (const gap of gaps) {
    if (gap.kind !== "provider-unavailable") continue;
    const existing = byLanguage.get(gap.language);
    if (existing) {
      existing.reason = gap.reason;
      if (!existing.files.includes(gap.file)) existing.files.push(gap.file);
      continue;
    }
    byLanguage.set(gap.language, { language: gap.language, reason: gap.reason, files: [gap.file] });
  }
  return [...byLanguage.values()].map((entry) => ({ ...entry, files: [...entry.files] }));
};

/**
 * 逐变更文件计算 C_push（规格 §3.3/§3.4），证据形态来自唯一权威判定：
 * - `static-bound-empty` → provenance = "static-bound-empty" 的 0 消费者；
 * - `provider-unavailable` → 不输出数值（证据缺口由 `symbolEvidenceGaps` 携带）；
 * - `symbol` → provenance = "symbol"，并列 staticBound（M≤N 校验）。
 */
export const computeChangeSurfaceForProfiles = (input: ChangeSurfaceForProfilesInput): ChangeSurfaceCollection => {
  const dossiers = symbolEvidenceDossiersForProfiles(input);
  const surfaces: FileChangeSurface[] = [];
  for (const dossier of dossiers) {
    const consumersByAnchor = dossier.consumersByAnchor;
    if (dossier.evidence === "provider-unavailable" || !consumersByAnchor) continue;
    surfaces.push({
      file: dossier.file,
      language: dossier.language,
      staticBound: dossier.staticConsumers.length,
      result: computeChangeSurfaceImpact({
        provenance: dossier.evidence === "static-bound-empty" ? "static-bound-empty" : "symbol",
        changes: dossier.changes,
        consumersByAnchor,
        // 静态上界非空但符号级 0 消费者 → 待确认（unconfirmed），不是结论 0（规格 §3.6）
        ...(dossier.evidence === "symbol"
          ? { unconfirmedAnchors: dossier.anchors.filter((anchor) => (consumersByAnchor.get(anchor)?.length ?? 0) === 0) }
          : {}),
        layerWeightOf: (file) => layerWeightOf(file, input.pathClasses),
      }),
    });
  }
  const symbolEvidenceGaps = dossiers.flatMap((dossier) => (dossier.gap ? [dossier.gap] : []));
  return {
    availability: surfaces.length > 0 ? "available" : "unavailable",
    surfaces,
    unavailableLanguages: unavailableLanguagesFromGaps(symbolEvidenceGaps),
    symbolEvidenceGaps,
  };
};
