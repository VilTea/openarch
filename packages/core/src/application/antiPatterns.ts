import { Effect } from "effect";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { ParserService } from "../port/ParserService";
import { antiPatternRulesDir } from "../infra/paths";
import { globSync } from "../infra/glob";
import { executeAntiPatternRule, type AntiPatternHit } from "../anti-patterns/engine";
import { listProjectSourceFiles } from "../projectFiles";
import type { AntiPatternScope, ChangeSetContext } from "../anti-patterns/engine";
import { loadAuthorityHygieneConfig } from "./authorityHygiene";
import { collectSymbolUseReports } from "./symbolHygiene";
import { loadScriptFacts } from "./scriptFacts";
import { requestedScriptCapabilities } from "../script-runtime/scriptRequirements";

const sourceFiles = (): readonly string[] => listProjectSourceFiles({ population: "production-governance" });

export interface AntiPatternReport {
  readonly rulesRun: number;
  readonly hits: readonly AntiPatternHit[];
  readonly errors: readonly string[];
  readonly unavailable: readonly string[];
  readonly sourcesRun: readonly string[];
  readonly ruleFailures: readonly { readonly source: string; readonly kind: "error" | "unavailable"; readonly message: string }[];
  readonly pruning: readonly { readonly rule: string; readonly inputFiles: number; readonly targetFiles: number; readonly candidateFiles: number; readonly records: number }[];
}

export interface AntiPatternsOptions {
  readonly rules?: readonly string[];
  readonly changeSet?: ChangeSetContext;
  readonly scopes?: readonly AntiPatternScope[];
}

const normalizeOptions = (input: readonly string[] | AntiPatternsOptions | undefined): AntiPatternsOptions =>
  Array.isArray(input) ? { rules: input as readonly string[] } : (input ?? {}) as AntiPatternsOptions;

export const antiPatterns = (input?: readonly string[] | AntiPatternsOptions) =>
  Effect.gen(function* () {
    const parser = yield* ParserService;
    const options = normalizeOptions(input);
    const scopes = options.scopes ?? (options.changeSet ? undefined : ["file", "repository"] as const);
    const rulesDirectory = antiPatternRulesDir();
    const discoveredRules = existsSync(rulesDirectory)
      ? globSync("*.mjs", { cwd: rulesDirectory }).map(file => `${rulesDirectory}/${file}`)
      : [];
    const rulePaths = options.rules && options.rules.length > 0 ? [...options.rules] : discoveredRules;
    const files = scopes?.every((scope) => scope === "change_set") ? [] : sourceFiles();
    const authorityConfig = loadAuthorityHygieneConfig();
    const requestedCapabilities = yield* Effect.promise(() => requestedScriptCapabilities(rulePaths));
    const facts = yield* loadScriptFacts({ files, authorities: authorityConfig.authorities, requestedCapabilities });
    const hits: AntiPatternHit[] = [];
    const errors: string[] = [];
    const unavailable: string[] = [];
    const sourcesRun: string[] = [];
    const ruleFailures: Array<{ source: string; kind: "error" | "unavailable"; message: string }> = [];
    const pruning: Array<{ rule: string; inputFiles: number; targetFiles: number; candidateFiles: number; records: number }> = [];
    const queryCache = new Map<string, Promise<readonly import("../port/ParserService").QueryMatch[]>>();
    let rulesRun = 0;
    for (const rule of rulePaths) {
      const source = basename(rule);
      const result = yield* Effect.promise(() => executeAntiPatternRule(rule, files, parser, undefined, {
        changeSet: options.changeSet,
        facts,
        scopes,
        queryCache,
      }));
      if (!result.skipped) {
        rulesRun++;
        sourcesRun.push(source);
      }
      hits.push(...result.hits);
      if (result.error) {
        errors.push(result.error);
        ruleFailures.push({ source, kind: "error", message: result.error });
      }
      if (result.unavailable) {
        unavailable.push(`${rule}: ${result.unavailable}`);
        ruleFailures.push({ source, kind: "unavailable", message: result.unavailable });
      }
      if (result.stages) pruning.push({
        rule,
        inputFiles: result.stages.inputFiles,
        targetFiles: result.stages.targetFiles.length,
        candidateFiles: result.stages.candidateFiles.length,
        records: result.stages.records.length,
      });
    }
    if (authorityConfig.symbolUse && !options.scopes) {
      for (const report of yield* collectSymbolUseReports()) {
        if (report.state.availability === "unavailable") {
          unavailable.push(`${report.origin.language} symbol-use: ${report.state.reason ?? "unavailable"}`);
          continue;
        }
        if (report.state.coverage.declarations !== "complete" || report.state.coverage.repositoryReferences !== "complete") {
          unavailable.push(`${report.origin.language} symbol-use: ${report.origin.providerId} reports incomplete declaration or repository-reference coverage`);
          continue;
        }
        for (const fact of report.facts) {
          if (fact.publicSurface !== "internal" || fact.repositoryReferences.length > 0) continue;
          hits.push({
            ruleId: "isolated-declaration",
            file: fact.declaration.file,
            message: `${fact.declaration.name} has no repository references in the analyzed ${report.origin.language} scope`,
            evidence: `line ${fact.declaration.line}; provider=${report.origin.providerId}; publicSurface=${fact.publicSurface}`,
            source: report.origin.providerId,
            scope: "repository",
          });
        }
      }
    }
    return { rulesRun, hits, errors, unavailable, sourcesRun: [...new Set(sourcesRun)].sort(), ruleFailures, pruning } as AntiPatternReport;
  });
