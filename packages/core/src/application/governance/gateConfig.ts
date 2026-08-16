// packages/core/src/application/governance/gateConfig.ts
// gate 配置加载——从 config.yml 解析规则/path_class/门禁阈值 + P95 基准读取。
// 拆出独立文件降低 gateApp.ts 的 CRL_state（2026-07-09）。
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { gatePerFile, type GateRule } from "./gate";
import { parsePathClasses } from "../pathClass";
import { DEFAULT_CRL_STATE_WEIGHTS, type P95Values, type CRLStateWeights } from "../../domain/crlState";
import { baselineIndex, configPath, toPosixPath } from "../../infra/paths";
import { createAnalysisScope, type AnalysisScope } from "../../domain/analysisScope";
import { unsupportedCelVariablesInCondition } from "../../domain/metricCatalog";
import { isFileKindRule } from "../../domain/testGovernance";
import type { StructuralPolicy, StructuralPolicyMode, StructuralPolicyRule, StructuralPolicyScope } from "../../domain/structuralPolicy";


interface ParsedConfig {
  languages?: string[];
  file_kinds?: unknown;
  rules_block?: Array<{ name: string; condition: string }>;
  rules_warn?: Array<{ name: string; condition: string }>;
  paths?: Record<string, { pattern: string; weight?: number }>;
  crl_state_weights?: Partial<CRLStateWeights>;
  structural_policies?: unknown;
}

export interface GateConfig {
  allRules: GateRule[];
  structuralPolicies: readonly StructuralPolicy[];
  explicitStructuralPolicies: boolean;
  pathEntries: Array<{ pattern: string; name: string; weight?: number }>;
  crlStateWeights: CRLStateWeights;
  analysisScope: AnalysisScope;
}

/** Configuration is governance evidence; callers must not convert a read failure into an empty policy. */
export class GateConfigurationError extends Error {
  readonly _tag = "GateConfigurationError";
  constructor(readonly path: string, readonly reason: string) {
    super(reason);
    this.name = "GateConfigurationError";
  }
}

/** gate 条件只能引用 authority 中 role=gate 的指标与 classifier（path_class/language）。
 *  report_only、retired、复合变量与未登记标识符一律拒绝——不按字符串黑名单猜测。 */
export const unsupportedMetricRules = (rules: readonly GateRule[]): GateRule[] =>
  rules.filter((rule) => unsupportedCelVariablesInCondition(rule.condition).length > 0);

const defaultGateConfig = (): GateConfig => ({
  allRules: [], structuralPolicies: [], explicitStructuralPolicies: false,
  pathEntries: [{ pattern: "**", name: "default" }], crlStateWeights: DEFAULT_CRL_STATE_WEIGHTS, analysisScope: createAnalysisScope([]),
});

const asRules = (value: unknown, level: "block" | "warn", label: string): readonly StructuralPolicyRule[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`${label}[${index}] must be a mapping`);
    const candidate = rule as { name?: unknown; condition?: unknown };
    if (typeof candidate.name !== "string" || candidate.name.trim() === "" || typeof candidate.condition !== "string" || candidate.condition.trim() === "") {
      throw new Error(`${label}[${index}] requires name and condition`);
    }
    return { name: candidate.name, condition: candidate.condition, level };
  });
};

const policyWeights = (value: unknown, fallback: CRLStateWeights, label: string): CRLStateWeights => {
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  return { ...fallback, ...(value as Partial<CRLStateWeights>) };
};

const policyScope = (value: unknown, label: string): StructuralPolicyScope | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
  const candidate = value as Record<string, unknown>;
  if (!Object.keys(candidate).every((key) => key === "include" || key === "exclude")) throw new Error(`${label} supports only include/exclude`);
  const patterns = (raw: unknown, field: "include" | "exclude"): readonly string[] | undefined => {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || raw.some((pattern) => typeof pattern !== "string" || pattern.trim() === "" || isAbsolute(pattern) || toPosixPath(pattern).split("/").includes(".."))) {
      throw new Error(`${label}.${field} must contain project-relative patterns`);
    }
    return raw as readonly string[];
  };
  const include = patterns(candidate.include, "include");
  const exclude = patterns(candidate.exclude, "exclude");
  if (!include && !exclude) throw new Error(`${label} must declare include or exclude`);
  return { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) };
};

const parseStructuralPolicies = (value: unknown, languages: readonly string[], defaultWeights: CRLStateWeights): readonly StructuralPolicy[] => {
  if (!Array.isArray(value)) throw new Error("structural_policies must be a list");
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`structural_policies[${index}] must be a mapping`);
    const candidate = raw as { id?: unknown; languages?: unknown; scope?: unknown; mode?: unknown; rules_block?: unknown; rules_warn?: unknown; crl_state_weights?: unknown };
    if (typeof candidate.id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(candidate.id)) throw new Error(`structural_policies[${index}].id is invalid`);
    if (ids.has(candidate.id)) throw new Error(`structural_policies duplicates id ${candidate.id}`);
    ids.add(candidate.id);
    if (!Array.isArray(candidate.languages) || candidate.languages.length === 0 || candidate.languages.some((language) => typeof language !== "string" || !languages.includes(language))) {
      throw new Error(`structural_policies[${index}].languages must be configured project languages`);
    }
    const profileLanguages = [...new Set(candidate.languages as string[])].sort();
    if (candidate.mode !== "observe" && candidate.mode !== "enforce") throw new Error(`structural_policies[${index}].mode must be observe or enforce`);
    const scope = policyScope(candidate.scope, `structural_policies[${index}].scope`);
    return {
      id: candidate.id,
      languages: profileLanguages,
      ...(scope ? { scope } : {}),
      mode: candidate.mode as StructuralPolicyMode,
      rules: [...asRules(candidate.rules_block, "block", `structural_policies[${index}].rules_block`), ...asRules(candidate.rules_warn, "warn", `structural_policies[${index}].rules_warn`)],
      crlStateWeights: policyWeights(candidate.crl_state_weights, defaultWeights, `structural_policies[${index}].crl_state_weights`),
    } satisfies StructuralPolicy;
  });
};

const readGateConfig = async (): Promise<GateConfig> => {
  try {
    const { load } = await import("js-yaml");
    const cfg = load(readFileSync(configPath(), "utf8")) as ParsedConfig | undefined;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("config root must be a mapping");
    const allRules = [...asRules(cfg.rules_block, "block", "rules_block"), ...asRules(cfg.rules_warn, "warn", "rules_warn")];
    const pathEntries = parsePathClasses(cfg);
    const fileKindRules = Array.isArray(cfg.file_kinds)
      ? cfg.file_kinds.filter(isFileKindRule)
      : [];
    const analysisScope = createAnalysisScope(Array.isArray(cfg.languages) ? cfg.languages : [], fileKindRules);
    const crlStateWeights = cfg.crl_state_weights ? { ...DEFAULT_CRL_STATE_WEIGHTS, ...cfg.crl_state_weights } : DEFAULT_CRL_STATE_WEIGHTS;
    const explicitStructuralPolicies = cfg.structural_policies !== undefined;
    const structuralPolicies = explicitStructuralPolicies
      ? parseStructuralPolicies(cfg.structural_policies, analysisScope.languages, crlStateWeights)
      : [{ id: "legacy-global", languages: analysisScope.languages, mode: "enforce" as const, rules: allRules, crlStateWeights }];
    return { allRules, structuralPolicies, explicitStructuralPolicies, pathEntries, crlStateWeights, analysisScope };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "configuration could not be read";
    throw new GateConfigurationError(configPath(), reason);
  }
};

/**
 * Compatibility/default resolution for fact consumers such as diff and project
 * scripts. It never supplies a policy verdict by itself.
 */
export const loadGateConfig = async (): Promise<GateConfig> => {
  try { return await readGateConfig(); } catch { return defaultGateConfig(); }
};

/** Policy collection must distinguish missing/corrupt configuration from no policy. */
export const loadGateConfigStrict = readGateConfig;

/** 从 _index.json 读取 P95 归一化基准 */
export const loadP95 = (): P95Values | undefined => {
  try {
    const idx = JSON.parse(readFileSync(baselineIndex(), "utf8"));
    return idx?.meta?.p95 as P95Values | undefined;
  } catch { return undefined; }
};
