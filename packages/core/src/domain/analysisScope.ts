import { extensionsForLanguages } from "../languageSupport";
import type { FileKindRule } from "./testGovernance";
import { toPosixPath } from "../infra/paths";

const EXCLUDED_SEGMENTS = ["/node_modules/", "/.git/", "/.openarch/", "/dist/", "/coverage/", "/vendor/"] as const;

export interface AnalysisScope {
  readonly languages: readonly string[];
  readonly extensions: readonly string[];
  readonly fileKindRules: readonly FileKindRule[];
  readonly fingerprint: string;
}

export const createAnalysisScope = (languages: readonly string[], fileKindRules: readonly FileKindRule[] = []): AnalysisScope => {
  const normalizedLanguages = [...new Set(languages)].sort();
  const extensions = [...extensionsForLanguages(normalizedLanguages)].sort();
  const rules = [...fileKindRules].map((rule) => ({ pattern: rule.pattern, kind: rule.kind })).sort((a, b) => `${a.pattern}:${a.kind}`.localeCompare(`${b.pattern}:${b.kind}`));
  return { languages: normalizedLanguages, extensions, fileKindRules: rules, fingerprint: `scope-v2:${normalizedLanguages.join(",")}:${extensions.join(",")}:${rules.map((rule) => `${rule.pattern}=${rule.kind}`).join(",")}` };
};

export const isPathInAnalysisScope = (path: string, scope: AnalysisScope): boolean => {
  const normalized = toPosixPath(path).toLowerCase();
  return scope.extensions.some((extension) => normalized.endsWith(extension))
    && !EXCLUDED_SEGMENTS.some((segment) => normalized.includes(segment));
};
