import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { configPath } from "../infra/paths";
import type { AntiPatternHit, AuthorityContract } from "../anti-patterns/engine";

interface RawAuthorityHygieneConfig {
  readonly authority_hygiene?: { readonly authorities?: unknown; readonly symbol_use?: unknown; readonly quality_rules?: unknown };
}

export type AuthorityHygieneQualityAction = "warn" | "block";

export interface AuthorityHygieneConfig {
  readonly authorities: readonly AuthorityContract[];
  readonly symbolUse: boolean;
  /** Opt-in enforcement for selected project quality scripts; other anti-patterns remain report-only. */
  readonly qualityRules: Readonly<Record<string, AuthorityHygieneQualityAction>>;
  readonly qualityConfigured: boolean;
  readonly qualityErrors: readonly string[];
}

export interface AuthorityHygieneQualityResult {
  readonly verdict: "PASS" | "WARN" | "BLOCK";
  readonly triggered: readonly { readonly hit: AntiPatternHit; readonly level: AuthorityHygieneQualityAction }[];
  readonly unavailable: readonly string[];
}

const parseAuthority = (value: unknown): AuthorityContract | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.owner !== "string") return undefined;
  const protectedPaths = Array.isArray(raw.protected_paths) && raw.protected_paths.every((path) => typeof path === "string")
    ? raw.protected_paths as readonly string[]
    : undefined;
  const prohibitedImports = Array.isArray(raw.prohibited_imports) && raw.prohibited_imports.every((source) => typeof source === "string")
    ? raw.prohibited_imports as readonly string[]
    : undefined;
  return {
    id: raw.id,
    owner: raw.owner,
    ...(typeof raw.public_entry === "string" ? { publicEntry: raw.public_entry } : {}),
    ...(protectedPaths ? { protectedPaths } : {}),
    ...(prohibitedImports ? { prohibitedImports } : {}),
  };
};

const parseQualityRules = (value: unknown): Pick<AuthorityHygieneConfig, "qualityRules" | "qualityConfigured" | "qualityErrors"> => {
  if (value === undefined) return { qualityRules: {}, qualityConfigured: false, qualityErrors: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { qualityRules: {}, qualityConfigured: true, qualityErrors: ["authority_hygiene.quality_rules must be a non-empty script-to-action map"] };
  }
  const qualityRules: Record<string, AuthorityHygieneQualityAction> = {};
  const qualityErrors: string[] = [];
  for (const [source, action] of Object.entries(value)) {
    if (!source.endsWith(".mjs") || (action !== "warn" && action !== "block")) {
      qualityErrors.push(`invalid authority_hygiene quality rule: ${source}`);
      continue;
    }
    qualityRules[source] = action;
  }
  if (Object.keys(qualityRules).length === 0 && qualityErrors.length === 0) qualityErrors.push("authority_hygiene.quality_rules must not be empty");
  return { qualityRules, qualityConfigured: true, qualityErrors };
};

/** Selected authority scripts fail closed when their facts are unavailable or were not executed. */
export const evaluateAuthorityHygieneQuality = (
  hits: readonly AntiPatternHit[],
  config: AuthorityHygieneConfig,
  sourcesRun: readonly string[],
  failures: readonly { readonly source: string; readonly kind: "error" | "unavailable"; readonly message: string }[],
): AuthorityHygieneQualityResult => {
  const selectedSources = Object.keys(config.qualityRules);
  const ran = new Set(sourcesRun);
  const unavailable = [
    ...selectedSources.filter((source) => !ran.has(source)).map((source) => `selected rule was not executed: ${source}`),
    ...failures.filter((failure) => config.qualityRules[failure.source] !== undefined).map((failure) => `${failure.kind}: ${failure.source}: ${failure.message}`),
  ];
  const triggered = hits.flatMap((hit) => {
    const level = config.qualityRules[hit.source];
    return level ? [{ hit, level }] : [];
  });
  const verdict = unavailable.length > 0 || triggered.some(({ level }) => level === "block")
    ? "BLOCK"
    : triggered.some(({ level }) => level === "warn")
      ? "WARN"
      : "PASS";
  return { verdict, triggered, unavailable };
};

/** Parses opt-in authority identities and explicit project quality policy without guessing either. */
export const parseAuthorityHygieneConfig = (value: unknown): AuthorityHygieneConfig => {
  const config = (value ?? {}) as RawAuthorityHygieneConfig;
  const authorities = config.authority_hygiene?.authorities;
  const unique = new Map<string, AuthorityContract>();
  if (Array.isArray(authorities)) {
    for (const authority of authorities) {
      const parsed = parseAuthority(authority);
      if (parsed && !unique.has(parsed.id)) unique.set(parsed.id, parsed);
    }
  }
  return {
    authorities: [...unique.values()],
    symbolUse: config.authority_hygiene?.symbol_use === true,
    ...parseQualityRules(config.authority_hygiene?.quality_rules),
  };
};

/** Reads opt-in project authority identities; invalid declarations are omitted rather than guessed. */
export const loadAuthorityHygieneConfig = (): AuthorityHygieneConfig => {
  try {
    return parseAuthorityHygieneConfig(load(readFileSync(configPath(), "utf8")));
  } catch {
    return { authorities: [], symbolUse: false, qualityRules: {}, qualityConfigured: false, qualityErrors: ["cannot read authority_hygiene configuration"] };
  }
};

export const loadAuthorityContracts = (): readonly AuthorityContract[] => loadAuthorityHygieneConfig().authorities;
