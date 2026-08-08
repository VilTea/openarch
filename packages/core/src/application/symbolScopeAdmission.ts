import type { SemanticFileProfile } from "./semanticDiff";
import type { SymbolUseReport } from "../symbol-use/types";
import type { SymbolVersionPairReport } from "../domain/symbolVersionPair";
import { assessSymbolScopeImpactAdmission, type SymbolScopeImpactAdmission } from "../domain/symbolScopeAdmission";
import { isPublicContractChange } from "./impactPlan";

const governanceAvailability = (coverage: SymbolUseReport["state"]["coverage"]["repositoryReferences"] | undefined) =>
  coverage === "complete" ? "available" as const : coverage ?? "unavailable" as const;

const changedSymbols = (profile: SemanticFileProfile): readonly string[] =>
  [...new Set(profile.changes
    .filter((change) => isPublicContractChange(change) && !change.anchor.startsWith("import:") && change.anchor !== "file")
    .map((change) => change.anchor.split(".").at(-1)!)
    .filter(Boolean))].sort();

/** 版本对证据：before/after 声明身份 + 共同 population（校准 2026-08-08——接已存在的
 *  versionPair 事实，不再硬编码 unavailable）。available 版本对 + matched 配对才支持
 *  身份判定；population.files 证明符号文件在 before/after 都被治理（common_population）。 */
const versionPairEvidenceFor = (
  versionPairs: readonly SymbolVersionPairReport[] | undefined,
  language: string,
  file: string,
  symbol: string,
): { before: boolean; afterStable: boolean; commonPopulation: boolean } => {
  if (!versionPairs) return { before: false, afterStable: false, commonPopulation: false };
  for (const pair of versionPairs) {
    if (pair.language !== language || pair.availability !== "available" || !pair.before || !pair.after) continue;
    // 符号文件在两个版本的共同治理 population 中 → 引用可归一化到版本化 population
    const commonPopulation = pair.population.files.includes(file);
    const beforeFact = pair.before.facts.find((fact) => fact.declaration.file === file && fact.declaration.name === symbol);
    if (!beforeFact) return { before: false, afterStable: false, commonPopulation };
    const matched = pair.declarations.some((declaration) =>
      declaration.status === "matched"
      && declaration.after?.declaration.file === file
      && declaration.after.declaration.name === symbol);
    return { before: true, afterStable: matched, commonPopulation };
  }
  return { before: false, afterStable: false, commonPopulation: false };
};

/**
 * Current provider reports describe the worktree only. This application
 * projection makes missing formula-admission prerequisites visible for changed
 * public contracts with an actual provider fact. It never turns an absent
 * provider match into a noisy pseudo-finding or an I_push input.
 */
export const assessSymbolScopeAdmissions = (
  profiles: readonly SemanticFileProfile[],
  reports: readonly SymbolUseReport[],
  versionPairs?: readonly SymbolVersionPairReport[],
  calibrationAvailable = false,
): readonly SymbolScopeImpactAdmission[] => profiles.flatMap((profile) => changedSymbols(profile).map((symbol) => {
  const report = reports.find((candidate) => candidate.facts.some((fact) => fact.declaration.file === profile.file && fact.declaration.name === symbol));
  const fact = report?.facts.find((candidate) => candidate.declaration.file === profile.file && candidate.declaration.name === symbol);
  if (!report || !fact) return undefined;
  const pairEvidence = versionPairEvidenceFor(versionPairs, report.origin.language, profile.file, symbol);
  return assessSymbolScopeImpactAdmission({
    language: report.origin.language,
    providerId: report.origin.providerId,
    file: profile.file,
    symbol,
    requirements: [
      { id: "before_declaration_identity", availability: pairEvidence.before ? "available" : "unavailable", ...(pairEvidence.before ? {} : { reason: "the provider was not run against the Git before revision" }) },
      { id: "after_declaration_identity", availability: pairEvidence.afterStable ? "available" : "partial", ...(pairEvidence.afterStable ? {} : { reason: "current provider facts do not yet carry a before/after-stable declaration identity" }) },
      { id: "repository_references", availability: governanceAvailability(report.state.coverage.repositoryReferences), ...(report.state.reason ? { reason: report.state.reason } : {}) },
      fact.publicSurface !== "unknown"
        ? { id: "public_surface", availability: "available" }
        : { id: "public_surface", availability: "unavailable", reason: "provider did not establish the declaration public surface" },
      { id: "common_population", availability: pairEvidence.commonPopulation ? "available" : "unavailable", ...(pairEvidence.commonPopulation ? {} : { reason: "symbol references are not yet normalized to a versioned metric population" }) },
      { id: "calibration_samples", availability: calibrationAvailable ? "available" : "partial", reason: calibrationAvailable ? "durable symbol calibration samples exist in project calibration store" : "no durable symbol calibration samples recorded; record positive and negative version-pair observations (matched/removed) via the calibration store" },
    ],
  });
}).filter((admission): admission is SymbolScopeImpactAdmission => admission !== undefined));

// admission version-pair probe: changed symbol
