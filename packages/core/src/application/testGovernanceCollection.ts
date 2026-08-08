import { Effect } from "effect";
import type { TestCaseSpanFact, TestFinding } from "../domain/testGovernance";
import type { CollectedTestFacts } from "../domain/testFacts";
import type { TestModuleAssociation } from "../domain/testAssociations";
import type { TestProviderCoverageInput } from "../domain/testProviderCoverage";
import { resolveTestModuleAssociations } from "./testAssociationResolver";
import type { TestFrameworkProvider } from "../test-governance/provider";
import type { ParserService } from "../port/ParserService";
import type { IndexEntry, StorageService } from "../port/StorageService";

export interface ProviderCollection {
  readonly findings: readonly TestFinding[];
  readonly testCaseSpans: readonly TestCaseSpanFact[];
  readonly collectedFacts: readonly CollectedTestFacts[];
  readonly providerCoverageInputs: readonly TestProviderCoverageInput[];
  readonly providerHandledTestFiles: readonly string[];
  readonly unrecognizedTestFiles: readonly string[];
  readonly failedTestFiles: readonly string[];
  readonly staticModuleAssociations: readonly { readonly testFile: string; readonly association: TestModuleAssociation }[];
  readonly associationUnavailableTestFiles: readonly string[];
  readonly errors: readonly string[];
}

/** Runs framework-specific collection; persistence is explicitly owned by the calling workflow. */
export const collectProviderFacts = (
  parser: ParserService,
  storage: StorageService,
  testEntries: ReadonlyArray<readonly [string, IndexEntry]>,
  providers: readonly TestFrameworkProvider[],
  productionPaths: ReadonlySet<string>,
  options: { readonly persist: boolean },
) => Effect.gen(function* () {
  const findings: TestFinding[] = [];
  const testCaseSpans: TestCaseSpanFact[] = [];
  const collectedFacts: CollectedTestFacts[] = [];
  const providerHandledTestFiles: string[] = [];
  const unrecognizedTestFiles: string[] = [];
  const failedTestFiles: string[] = [];
  const staticModuleAssociations: Array<{ testFile: string; association: TestModuleAssociation }> = [];
  const associationUnavailableTestFiles: string[] = [];
  const errors: string[] = [];
  const providerCoverageInputs = new Map<string, { providerId: string; candidateTestFiles: string[]; unbaselinedTestFiles: string[]; providerHandledTestFiles: string[]; failedTestFiles: string[] }>(
    providers.map((provider) => [provider.id, { providerId: provider.id, candidateTestFiles: [], unbaselinedTestFiles: [], providerHandledTestFiles: [], failedTestFiles: [] }]),
  );
  const exportedSymbolsByPath = new Map<string, import("../domain/ast").FileAst["exportedSymbols"]>();

  for (const [path, entry] of testEntries) {
    const provider = providers.find((candidate) => candidate.supports(path));
    if (!provider) {
      unrecognizedTestFiles.push(path);
      continue;
    }
    const providerCoverage = providerCoverageInputs.get(provider.id)!;
    providerCoverage.candidateTestFiles.push(path);
    try {
      const collected = yield* Effect.promise(() => provider.collect(path, parser));
      providerHandledTestFiles.push(path);
      providerCoverage.providerHandledTestFiles.push(path);
      const providerFindings = collected.findings.map((finding) => ({ ...finding, source: provider.id }));
      findings.push(...providerFindings);
      testCaseSpans.push(...(collected.testCaseSpans ?? []).map((span) => ({ ...span, file: path, providerId: provider.id })));
      collectedFacts.push({ providerId: provider.id, tests: collected.tests });
      const parsed = yield* Effect.either(parser.parse(path));
      const moduleAssociations = parsed._tag === "Right"
        ? yield* resolveTestModuleAssociations(parser, parsed.right, productionPaths, collected.symbolCallEvidence ?? [], exportedSymbolsByPath)
        : undefined;
      if (moduleAssociations === undefined) associationUnavailableTestFiles.push(path);
      else staticModuleAssociations.push(...moduleAssociations.map((association) => ({ testFile: path, association })));
      if (options.persist) {
        yield* storage.writeFileMetrics(path, {
          ...entry,
          fileKind: "test",
          testMetrics: { schemaVersion: "4", providerId: provider.id, tests: collected.tests, findings: providerFindings, moduleAssociations },
        });
      }
    } catch (error) {
      failedTestFiles.push(path);
      providerCoverage.failedTestFiles.push(path);
      errors.push(`${provider.id}: ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    findings, testCaseSpans, collectedFacts, providerHandledTestFiles, unrecognizedTestFiles, failedTestFiles,
    providerCoverageInputs: [...providerCoverageInputs.values()], staticModuleAssociations, associationUnavailableTestFiles, errors,
  } satisfies ProviderCollection;
});
