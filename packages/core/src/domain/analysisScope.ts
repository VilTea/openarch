import { extensionsForLanguages } from "../languageSupport";
import type { FileKindRule } from "./testGovernance";
import { toPosixPath } from "../infra/paths";
import { SCAN_EXCLUDED_SEGMENTS } from "../infra/scanExclusions";

export interface AnalysisScope {
  readonly languages: readonly string[];
  readonly extensions: readonly string[];
  readonly fileKindRules: readonly FileKindRule[];
  readonly fingerprint: string;
}

/**
 * 分析范围的**身份**（唯一 authority）。它同时是：
 * 1. gate 的 baseline 兼容判据（`baseline_scope_incompatible`）；
 * 2. 结构校准 id 的组成项（`calibration.ts`）——范围变了，旧校准必须失效；
 * 3. `status` 的 scope 兼容性报告来源。
 *
 * 契约纪律：任何会改变"哪些文件在范围内 / 各自算什么 kind"的语义，都必须进入本字符串，
 * 否则持久化事实（baseline 的 `fileKind`、封存校准）会静默按旧语义继续有效。
 * - 能表达为 `fileKindRules` 的语义（如 Java 布局推导规则）由调用方注入规则，
 *   自动进入 `rules` 分量，且只影响真正受影响的项目；
 * - 无法表达为规则的默认分类器语义变化 ⇒ 递增 `scope-vN` 前缀（全局失效，代价明确）。
 */
export const createAnalysisScope = (languages: readonly string[], fileKindRules: readonly FileKindRule[] = []): AnalysisScope => {
  const normalizedLanguages = [...new Set(languages)].sort();
  const extensions = [...extensionsForLanguages(normalizedLanguages)].sort();
  const rules = [...fileKindRules].map((rule) => ({ pattern: rule.pattern, kind: rule.kind })).sort((a, b) => `${a.pattern}:${a.kind}`.localeCompare(`${b.pattern}:${b.kind}`));
  return { languages: normalizedLanguages, extensions, fileKindRules: rules, fingerprint: `scope-v2:${normalizedLanguages.join(",")}:${extensions.join(",")}:${rules.map((rule) => `${rule.pattern}=${rule.kind}`).join(",")}` };
};

export const isPathInAnalysisScope = (path: string, scope: AnalysisScope): boolean => {
  const normalized = toPosixPath(path).toLowerCase();
  return scope.extensions.some((extension) => normalized.endsWith(extension))
    && !SCAN_EXCLUDED_SEGMENTS.some((segment) => normalized.includes(segment));
};
