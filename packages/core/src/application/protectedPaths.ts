// packages/core/src/application/protectedPaths.ts
// Minimal protected-path policy inside authority_hygiene. It is a change-level
// gate only: it never builds an override/ASK state machine. Paths are
// project-relative patterns evaluated with minimatch.
import { minimatch } from "minimatch";
import { configPath, toPosixPath } from "../infra/paths";
import { readProjectConfig } from "../projectFiles";

export type ProtectedPathLevel = "warn" | "block";

export interface ProtectedPathRule {
  readonly pattern: string;
  readonly level: ProtectedPathLevel;
  readonly reason: string;
  /** 最小例外记录：这些项目相对 glob 的变更不触发该规则（例如已评审的契约文件）。 */
  readonly allow?: readonly string[];
}

export interface ProtectedPathPolicy {
  readonly configured: boolean;
  readonly rules: readonly ProtectedPathRule[];
  readonly errors: readonly string[];
}

export interface ProtectedPathTrigger {
  readonly path: string;
  readonly rule: ProtectedPathRule;
}

export interface ProtectedPathVerdict {
  readonly verdict: "PASS" | "WARN" | "BLOCK";
  readonly triggered: readonly ProtectedPathTrigger[];
}

const parseProtectedPaths = (value: unknown): { rules: ProtectedPathRule[]; errors: string[] } => {
  if (value === undefined) return { rules: [], errors: [] };
  if (!Array.isArray(value)) return { rules: [], errors: ["authority_hygiene.protected_paths must be a list"] };
  const rules: ProtectedPathRule[] = [];
  const errors: string[] = [];
  value.forEach((raw, index) => {
    const label = `authority_hygiene.protected_paths[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${label} must be a mapping`);
      return;
    }
    const candidate = raw as { pattern?: unknown; level?: unknown; reason?: unknown; allow?: unknown };
    const pattern = typeof candidate.pattern === "string" ? candidate.pattern.trim() : "";
    if (!pattern || pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern) || toPosixPath(pattern).split("/").includes("..")) {
      errors.push(`${label}.pattern must be a project-relative glob`);
      return;
    }
    if (candidate.level !== "warn" && candidate.level !== "block") {
      errors.push(`${label}.level must be warn or block`);
      return;
    }
    if (typeof candidate.reason !== "string" || candidate.reason.trim() === "") {
      errors.push(`${label}.reason must be a non-empty string`);
      return;
    }
    let allow: readonly string[] | undefined;
    if (candidate.allow !== undefined) {
      if (!Array.isArray(candidate.allow) || candidate.allow.some((item) => typeof item !== "string" || item.trim() === "" || item.startsWith("/") || /^[A-Za-z]:/.test(item) || toPosixPath(item).split("/").includes(".."))) {
        errors.push(`${label}.allow must contain project-relative globs`);
        return;
      }
      allow = candidate.allow.map((item) => item.trim());
    }
    rules.push({ pattern, level: candidate.level, reason: candidate.reason.trim(), ...(allow ? { allow } : {}) });
  });
  return { rules, errors };
};

/** Parses opt-in protected-path policy from config.yml; invalid declarations are surfaced, never guessed. */
export const parseProtectedPathPolicy = (value: unknown): ProtectedPathPolicy => {
  const config = (value ?? {}) as { authority_hygiene?: { protected_paths?: unknown } };
  const { rules, errors } = parseProtectedPaths(config.authority_hygiene?.protected_paths);
  return { configured: config.authority_hygiene?.protected_paths !== undefined, rules, errors };
};

/**
 * 读取 opt-in 保护路径策略。读取走 `readProjectConfig`（config.yml 唯一读取权威，D-G13），
 * 不再自己 `load(readFileSync(...))` + `catch`。
 *
 * `configured: true` 在"读不出来"时**保留**（与旧行为一致）：该字段的语义是"策略上下文存在、
 * 不得按空策略猜测"，而不是"解析成功"——真正的失败原因在 `errors` 里，且现在缺文件与解析失败
 * 分别给出可读原因（旧实现把两者压成同一句话）。
 */
export const loadProtectedPathPolicy = (): ProtectedPathPolicy => {
  const path = configPath();
  const read = readProjectConfig(path);
  if (read.status === "missing") {
    return { configured: true, rules: [], errors: [`cannot read authority_hygiene protected_paths: ${path} does not exist`] };
  }
  if (read.status === "invalid") {
    return { configured: true, rules: [], errors: [`cannot read authority_hygiene protected_paths: ${read.error}`] };
  }
  return parseProtectedPathPolicy(read.value);
};

const matchesRule = (path: string, rule: ProtectedPathRule): boolean => {
  const candidate = toPosixPath(path);
  return minimatch(candidate, rule.pattern, { dot: true });
};

export const evaluateProtectedPaths = (changedPaths: readonly string[], policy: ProtectedPathPolicy): ProtectedPathVerdict => {
  const triggered = policy.rules.flatMap((rule) =>
    changedPaths
      .filter((path) => matchesRule(path, rule) && !(rule.allow ?? []).some((allowed) => minimatch(toPosixPath(path), allowed, { dot: true })))
      .map((path) => ({ path, rule })),
  );
  const verdict = triggered.some(({ rule }) => rule.level === "block")
    ? "BLOCK"
    : triggered.some(({ rule }) => rule.level === "warn")
      ? "WARN"
      : "PASS";
  return { verdict, triggered };
};
