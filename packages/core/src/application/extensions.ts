import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isAntiPatternRule } from "../anti-patterns/engine";
import { implicitDepsRulesDir, antiPatternRulesDir, testGovernanceRulesDir } from "../infra/paths";
import { isImplicitDependencyRule } from "../implicit-deps/engine";
import { loadDefaultExport, type ScriptImport } from "../script-runtime/loadDefaultExport";
import { isTestFindingScript } from "../test-governance/engine";
import { SCRIPT_FACT_CAPABILITIES, scriptFactRequirementsError } from "../script-runtime/projectFacts";
import { SCRIPT_AST_FACTS } from "../staged-analysis/types";
import { defaultScriptIdForPath } from "./defaultScripts";

export type ExtensionEngine = "anti-patterns" | "implicit-deps" | "test-governance";

export interface ExtensionContractIssue {
  readonly engine: ExtensionEngine;
  readonly path: string;
  readonly error: string;
}

export interface ExtensionContractReport {
  readonly checked: number;
  readonly byEngine: Readonly<Record<ExtensionEngine, number>>;
  readonly issues: readonly ExtensionContractIssue[];
}

export interface ScriptFactConsumerStats {
  /** 该事实被 installed scripts 的 `requires` 引用次数。 */
  readonly requires: number;
  /** 该事实被 installed scripts 的 `ast: { fact }` 阶段引用次数。 */
  readonly astFact: number;
  readonly files: readonly string[];
}

export interface ExtensionContractOptions {
  readonly directories?: Partial<Record<ExtensionEngine, string>>;
  readonly importFn?: ScriptImport;
}

const defaultDirectories = (): Record<ExtensionEngine, string> => ({
  "anti-patterns": antiPatternRulesDir(),
  "implicit-deps": implicitDepsRulesDir(),
  "test-governance": testGovernanceRulesDir(),
});

const FACT_ID_ALIASES = new Map<string, string>(
  [...SCRIPT_FACT_CAPABILITIES, ...SCRIPT_AST_FACTS].flatMap((fact) =>
    (fact.aliases ?? []).map((alias) => [alias, fact.id] as const),
  ),
);

const canonicalFactId = (id: string): string => FACT_ID_ALIASES.get(id) ?? id;

/**
 * 采集已安装项目脚本的事实消费（requires + ast.fact），供 rules facts 的
 * 消费观测面使用。只读加载、不执行 link；损坏脚本由 checkExtensionContracts
 * 负责报错，这里跳过而不是假装零消费。
 */
export const scriptFactConsumers = async (
  options: ExtensionContractOptions = {},
): Promise<Readonly<Record<string, ScriptFactConsumerStats>>> => {
  const directories = { ...defaultDirectories(), ...options.directories };
  const consumers = new Map<string, { requires: number; astFact: number; files: Set<string> }>();
  const touch = (id: string, kind: "requires" | "astFact", path: string): void => {
    const entry = consumers.get(id) ?? { requires: 0, astFact: 0, files: new Set<string>() };
    entry[kind] += 1;
    entry.files.add(path);
    consumers.set(id, entry);
  };

  for (const engine of Object.keys(directories) as ExtensionEngine[]) {
    const directory = directories[engine];
    if (!directory || !existsSync(directory)) continue;
    const files = readdirSync(directory).filter((file) => file.endsWith(".mjs")).sort();
    for (const file of files) {
      const path = join(directory, file);
      const loaded = await loadDefaultExport(path, options.importFn);
      if (loaded.error || !loaded.value || typeof loaded.value !== "object") continue;
      const value = loaded.value as { requires?: unknown; stages?: { ast?: { fact?: unknown } } };
      if (Array.isArray(value.requires)) {
        for (const capability of value.requires) {
          if (typeof capability === "string") touch(canonicalFactId(capability), "requires", path);
        }
      }
      const fact = value.stages?.ast && typeof value.stages.ast === "object"
        ? (value.stages.ast as { fact?: unknown }).fact
        : undefined;
      if (typeof fact === "string") touch(canonicalFactId(fact), "astFact", path);
    }
  }

  return Object.fromEntries([...consumers.entries()].map(([id, entry]) => [id, {
    requires: entry.requires,
    astFact: entry.astFact,
    files: [...entry.files].sort(),
  }]));
};

const contractError = (engine: ExtensionEngine): string => {
  if (engine === "anti-patterns") return "必须 export default；file/repository 规则导出 { scope, stages, link }；change_set 规则导出 { scope, detect }";
  return "必须 export default { stages, link }";
};

const validates = (engine: ExtensionEngine, value: unknown): boolean => {
  if (engine === "anti-patterns") return isAntiPatternRule(value);
  if (engine === "implicit-deps") return isImplicitDependencyRule(value);
  return isTestFindingScript(value);
};

/**
 * Checks project-owned extension modules without executing link callbacks or project scans.
 * It is a contract preflight before an agent calibrates a new defensive rule.
 */
export const checkExtensionContracts = async (options: ExtensionContractOptions = {}): Promise<ExtensionContractReport> => {
  const directories = { ...defaultDirectories(), ...options.directories };
  const byEngine: Record<ExtensionEngine, number> = {
    "anti-patterns": 0,
    "implicit-deps": 0,
    "test-governance": 0,
  };
  const issues: ExtensionContractIssue[] = [];

  for (const engine of Object.keys(directories) as ExtensionEngine[]) {
    const directory = directories[engine];
    if (!directory || !existsSync(directory)) continue;
    const files = readdirSync(directory).filter((file) => file.endsWith(".mjs")).sort();
    for (const file of files) {
      const path = join(directory, file);
      byEngine[engine] += 1;
      const loaded = await loadDefaultExport(path, options.importFn);
      if (loaded.error) {
        issues.push({ engine, path, error: loaded.error });
      } else {
        const requires = loaded.value && typeof loaded.value === "object"
          ? (loaded.value as Record<string, unknown>).requires
          : undefined;
        const requirementError = scriptFactRequirementsError(requires);
        if (requirementError) {
          issues.push({ engine, path, error: requirementError });
        } else if (!validates(engine, loaded.value)) {
          const defaultAsset = defaultScriptIdForPath(path);
          const migration = defaultAsset ? `；默认资产可显式替换: openarch init --replace-script ${defaultAsset}` : "";
          issues.push({ engine, path, error: `${contractError(engine)}${migration}` });
        }
      }
    }
  }

  return { checked: Object.values(byEngine).reduce((total, count) => total + count, 0), byEngine, issues };
};
