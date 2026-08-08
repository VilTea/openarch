import { Effect } from "effect";
import { antiPatterns, collectGitChangeSet, evaluateAuthorityHygieneQuality, loadAuthorityHygieneConfig, type AntiPatternReport } from "@openarch/core";
import { CommandHandler, LiveLayer, parseOptionValues } from "../runtime";
import { type Locale, message } from "../i18n";

const report = (line: string): void => console.log(line);

const printCalibration = (locale: Locale,
  result: AntiPatternReport,
  changeSet?: { readonly availability: string; readonly files: readonly unknown[] },
): void => {
  report(message(locale, "antiPatterns.heading"));
  if (changeSet) report(message(locale, "antiPatterns.changeSet", { state: changeSet.availability.toUpperCase(), files: changeSet.files.length }));
  report(message(locale, "antiPatterns.rules", { count: result.rulesRun }));
  report(message(locale, "antiPatterns.findings", { count: result.hits.length }));
  for (const hit of result.hits) {
    const location = hit.line === undefined ? hit.file : `${hit.file}:${hit.line}${hit.endLine && hit.endLine !== hit.line ? `-${hit.endLine}` : ""}`;
    const metadata = [
      hit.category && `category=${hit.category}`,
      hit.severity && `severity=${hit.severity}`,
      hit.patternFamily && `family=${hit.patternFamily}`,
    ].filter(Boolean).join(", ");
    report(message(locale, "antiPatterns.finding", {
      scope: hit.scope,
      rule: hit.ruleId,
      location,
      detail: hit.message,
      evidence: hit.evidence ? ` (${hit.evidence})` : "",
      metadata: metadata ? ` [${metadata}]` : "",
      suggestion: hit.suggestion ? message(locale, "antiPatterns.suggestion", { suggestion: hit.suggestion }) : "",
    }));
  }
  for (const error of result.errors) report(`  [RULE ERROR] ${error}`);
  for (const unavailable of result.unavailable) report(`  [UNAVAILABLE] ${unavailable}`);
  for (const pruning of result.pruning) {
    report(message(locale, "antiPatterns.pruning", { rule: pruning.rule, input: pruning.inputFiles, targets: pruning.targetFiles, candidates: pruning.candidateFiles, records: pruning.records }));
  }
};

const authorityQualityExitCode = (result: AntiPatternReport, locale: Locale): number => {
  const authority = loadAuthorityHygieneConfig();
  report(message(locale, "antiPatterns.authorityHeading"));
  if (!authority.qualityConfigured) {
    report(message(locale, "antiPatterns.verdict", { verdict: "NOT_CONFIGURED" }));
    return 0;
  }
  if (authority.qualityErrors.length > 0) {
    report(message(locale, "antiPatterns.verdict", { verdict: "INVALID_POLICY" }));
    for (const error of authority.qualityErrors) report(`  [CONFIG ERROR] ${error}`);
    return 3;
  }
  const decision = evaluateAuthorityHygieneQuality(result.hits, authority, result.sourcesRun, result.ruleFailures);
  report(message(locale, "antiPatterns.verdict", { verdict: decision.verdict }));
  for (const item of decision.triggered) report(`  [${item.level.toUpperCase()}:${item.hit.source}:${item.hit.ruleId}] ${item.hit.file}: ${item.hit.message}`);
  for (const unavailable of decision.unavailable) report(`  [UNAVAILABLE] ${unavailable}`);
  return decision.verdict === "BLOCK" ? 2 : decision.verdict === "WARN" ? 1 : 0;
};

export const antiPatternsCommand: CommandHandler = async (args, context) => {
  const rules = parseOptionValues(args, "--rule");
  const changed = args.includes("--changed");
  const qualityCheck = args.includes("--check");
  const changedPaths = parseOptionValues(args, "--changed");
  const changeSet = changed ? collectGitChangeSet(context.cwd, changedPaths) : undefined;
  const result = await Effect.runPromise(antiPatterns({
    rules: rules.length > 0 ? rules : undefined,
    changeSet,
    scopes: changed ? ["change_set"] : undefined,
  }).pipe(Effect.provide(LiveLayer)));

  const locale = context.locale;
  printCalibration(locale, result, changeSet);
  return qualityCheck ? authorityQualityExitCode(result, locale) : 0;
};
