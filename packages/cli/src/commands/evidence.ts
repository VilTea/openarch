import { Effect } from "effect";
import { readProjectLanguages, testGovernance, validateValidationEvidence, type EvidenceVerdict, type TestGovernanceReport } from "@openarch/core";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { exitCodeFromError } from "../exit-code";
import { CommandHandler, LiveLayer, parseOptionValue, printAnalysisError } from "../runtime";
import { OPENARCH_VERSION } from "../version";

export interface EvidenceScope {
  readonly providerId: string;
  readonly ruleId: string;
  readonly authorityId: string;
}

export const scopedTestEvidence = (
  report: Pick<TestGovernanceReport, "decision" | "collection">,
  scope: EvidenceScope,
): { readonly findingCount: number; readonly policyVerdict: EvidenceVerdict } => {
  if (report.decision.errors.length > 0) throw new Error(`incomplete provider result: ${report.decision.errors.join("; ")}`);
  if (!report.collection.providersRun.includes(scope.providerId)) throw new Error(`provider was not run: ${scope.providerId}`);
  const coverage = report.collection.providerCoverage.find((entry) => entry.providerId === scope.providerId);
  if (!coverage) throw new Error(`provider coverage unavailable: ${scope.providerId}`);
  if (coverage.status !== "available") {
    throw new Error(`provider coverage is ${coverage.status}: ${coverage.reasons.join(", ")}`);
  }
  const matches = report.decision.findings.filter((finding) => finding.source === scope.providerId && finding.ruleId === scope.ruleId);
  const triggered = report.decision.triggered.filter(({ finding }) => finding.source === scope.providerId && finding.ruleId === scope.ruleId);
  const policyVerdict: EvidenceVerdict = triggered.some(({ level }) => level === "block")
    ? "BLOCK"
    : triggered.some(({ level }) => level === "warn") ? "WARN" : "PASS";
  return { findingCount: matches.length, policyVerdict };
};

export const evidenceCommand: CommandHandler = async (args, context) => {
  const subject = args.find((arg) => !arg.startsWith("--"));
  const projectToken = parseOptionValue(args, "--project-token");
  const providerId = parseOptionValue(args, "--provider-id");
  const ruleId = parseOptionValue(args, "--rule-id");
  const authorityId = parseOptionValue(args, "--authority-id");
  if (subject !== "test" || !projectToken || !providerId || !ruleId || !authorityId) {
    console.error("用法: openarch calibration export test --project-token <opaque-token> --provider-id <id> --rule-id <id> --authority-id <opaque-id>");
    return 3;
  }

  const result = await Effect.runPromise(testGovernance().pipe(Effect.provide(LiveLayer), Effect.either));
  if (result._tag === "Left") {
    printAnalysisError(result.left);
    return exitCodeFromError(result.left);
  }
  let scoped: ReturnType<typeof scopedTestEvidence>;
  try {
    scoped = scopedTestEvidence(result.right, { providerId, ruleId, authorityId });
  } catch (error) {
    console.error(`无法导出校准证据: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let languages: readonly string[] = readProjectLanguages(context.cwd);
  try {
    const config = load(readFileSync(`${context.cwd}/.openarch/config.yml`, "utf8")) as { languages?: unknown } | undefined;
    if (!Array.isArray(config?.languages) || config.languages.length === 0) languages = ["unknown"];
  } catch {
    languages = ["unknown"];
  }

  const now = new Date();
  const evidence = validateValidationEvidence({
    schemaVersion: "2",
    projectToken,
    observedAt: now.toISOString(),
    window: {
      startedAt: new Date(now.getTime() - 86_400_000).toISOString(),
      endedAt: now.toISOString(),
    },
    openarchVersion: OPENARCH_VERSION,
    languages,
    provider: { id: providerId, version: "1" },
    ruleId,
    authorityId,
    findingCount: scoped.findingCount,
    policyVerdict: scoped.policyVerdict,
    confirmedFalsePositiveCount: 0,
    confirmedFalseNegativeCount: 0,
    evidenceLevel: "observed",
  });

  console.log(JSON.stringify(evidence, null, 2));
  return 0;
};
