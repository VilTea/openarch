import { Effect } from "effect";
import { antiPatterns, type AntiPatternReport } from "../antiPatterns";
import { gateApp, type GateAppOutput } from "./gateApp";
import { review, type ReviewReport } from "./review";
import { testGovernance, type TestGovernanceReport } from "../testGovernance";

export interface DiagnosticAvailable<T> {
  readonly state: "available";
  readonly value: T;
}

export interface DiagnosticUnavailable {
  readonly state: "unavailable";
  readonly reason: string;
}

export type DiagnosticPart<T> = DiagnosticAvailable<T> | DiagnosticUnavailable;

export interface GovernanceDiagnosticsReport {
  readonly gate: GateAppOutput;
  readonly review: ReviewReport;
  readonly antiPatterns: DiagnosticPart<AntiPatternReport>;
  readonly tests: DiagnosticPart<TestGovernanceReport>;
}

const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const capture = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<DiagnosticPart<A>, never, R> =>
  effect.pipe(
    Effect.map((value) => ({ state: "available", value }) as const),
    Effect.catchAll((error) => Effect.succeed({ state: "unavailable", reason: reasonOf(error) } as const)),
  );

/**
 * One report-only projection for the first governance investigation.
 * It composes existing evidence producers and intentionally does not change gate semantics.
 */
export const governanceDiagnostics = () =>
  Effect.gen(function* () {
    const gate = yield* gateApp();
    const antiPatternsReport = yield* capture(antiPatterns());
    const testReport = yield* capture(testGovernance({ persistence: "read" }));
    const reviewReport = yield* review();
    return { gate, review: reviewReport, antiPatterns: antiPatternsReport, tests: testReport } as GovernanceDiagnosticsReport;
  });
