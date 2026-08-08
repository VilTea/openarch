import { LAMBDA_AST, type ChangeKind } from "./weights";
import type { SymbolCalibrationProfile } from "./symbolCalibration";
import type { SymbolUseDeclarationFamily, SymbolUseCoverage } from "../symbol-use/types";

export const SYMBOL_SCOPE_METRIC_FORMULA = "lambda_ast * alpha_struct * log2(symbol_consumer_count + 1) * omega_layer" as const;

export interface SymbolScopeMetricInput {
  readonly language: string;
  readonly providerId: string;
  readonly file: string;
  readonly symbol: string;
  readonly declarationFamily: SymbolUseDeclarationFamily;
  readonly changeKind: ChangeKind;
  readonly alphaStruct: number;
  readonly layerWeight: number;
  readonly repositoryReferences: readonly string[];
  /** Static reverse-import consumers remain a parallel comparison, never an additive input. */
  readonly staticImportConsumers?: readonly string[];
  readonly declarationsCoverage: SymbolUseCoverage;
  readonly repositoryReferencesCoverage: SymbolUseCoverage;
  readonly publicSurface: "internal" | "declared-public" | "unknown";
  readonly commonPopulationFingerprint: string;
  readonly calibrationProfile: SymbolCalibrationProfile;
}

export interface SymbolScopeMetricResult {
  readonly role: "shadow";
  readonly language: string;
  readonly providerId: string;
  readonly file: string;
  readonly symbol: string;
  readonly declarationFamily: SymbolUseDeclarationFamily;
  readonly formula: typeof SYMBOL_SCOPE_METRIC_FORMULA;
  readonly lambdaAst: number;
  readonly alphaStruct: number;
  readonly layerWeight: number;
  readonly availability: "available" | "partial" | "unavailable";
  readonly eligible: boolean;
  readonly symbolConsumerCount?: number;
  readonly staticConsumerCount?: number;
  readonly symbolScopeImpact?: number;
  readonly staticComparableImpact?: number;
  readonly reasons: readonly string[];
}

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)].sort();

const complete = (input: SymbolScopeMetricInput): boolean =>
  input.declarationsCoverage === "complete" && input.repositoryReferencesCoverage === "complete";

const identityMatches = (input: SymbolScopeMetricInput): boolean =>
  input.calibrationProfile.language === input.language
  && input.calibrationProfile.providerId === input.providerId
  && input.calibrationProfile.declarationFamily === input.declarationFamily
  && input.calibrationProfile.commonPopulationFingerprint === input.commonPopulationFingerprint;

const finiteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

const impactFor = (input: SymbolScopeMetricInput, consumerCount: number): number =>
  LAMBDA_AST[input.changeKind]
  * input.alphaStruct
  * Math.log2(consumerCount + 1)
  * input.layerWeight;

/**
 * Computes an independently reported symbol-scope impact. It is intentionally
 * unavailable unless the provider, profile and both coverage dimensions agree.
 */
export const computeSymbolScopeMetric = (input: SymbolScopeMetricInput): SymbolScopeMetricResult => {
  const reasons = [
    !finiteNonNegative(input.alphaStruct) ? "alpha_struct must be finite and non-negative" : undefined,
    !finiteNonNegative(input.layerWeight) ? "layer weight must be finite and non-negative" : undefined,
    !input.calibrationProfile.eligible ? "calibration profile is not eligible" : undefined,
    !identityMatches(input) ? "metric input does not match calibration profile identity" : undefined,
    input.publicSurface === "unknown" ? "public surface is unknown" : undefined,
    !complete(input) ? "symbol declaration or repository reference coverage is incomplete" : undefined,
  ].filter((reason): reason is string => Boolean(reason));
  const symbolConsumers = unique(input.repositoryReferences.filter((file) => file !== input.file));
  const staticConsumers = input.staticImportConsumers === undefined ? undefined : unique(input.staticImportConsumers.filter((file) => file !== input.file));
  const available = reasons.length === 0;
  const unavailable = !input.calibrationProfile.commonPopulationFingerprint || (input.calibrationProfile.availability === "unavailable" && !input.calibrationProfile.eligible);
  return {
    role: "shadow",
    language: input.language,
    providerId: input.providerId,
    file: input.file,
    symbol: input.symbol,
    declarationFamily: input.declarationFamily,
    formula: SYMBOL_SCOPE_METRIC_FORMULA,
    lambdaAst: LAMBDA_AST[input.changeKind],
    alphaStruct: input.alphaStruct,
    layerWeight: input.layerWeight,
    availability: available ? "available" : unavailable ? "unavailable" : "partial",
    eligible: available,
    ...(available ? {
      symbolConsumerCount: symbolConsumers.length,
      symbolScopeImpact: impactFor(input, symbolConsumers.length),
      ...(staticConsumers ? { staticConsumerCount: staticConsumers.length, staticComparableImpact: impactFor(input, staticConsumers.length) } : {}),
    } : {}),
    reasons,
  };
};
