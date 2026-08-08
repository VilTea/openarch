import { relative, resolve } from "node:path";
import { Effect } from "effect";
import type { Language } from "../../../src/domain/ast";
import { buildDependencyGraph, computeReverseEdges } from "../../../src/domain/graph";
import { listProjectSourceFiles } from "../../../src/projectFiles";
import { ParserService } from "../../../src/port/ParserService";

export interface StaticImportConsumerScope {
  readonly sourceFiles: readonly string[];
  readonly consumers: readonly string[];
}

/** Calibration-only projection of the same production static-import scope used by I_push. */
export const collectStaticImportConsumers = (cwd: string, language: Language, declarationFile: string) =>
  Effect.gen(function* () {
    const parser = yield* ParserService;
    const files = listProjectSourceFiles({ cwd, languages: [language], population: "production-governance" });
    const asts = yield* Effect.all(files.map((file) => parser.parse(file)), { concurrency: "unbounded" });
    const reverseEdges = computeReverseEdges(buildDependencyGraph(asts, undefined, cwd));
    const relativeFile = (file: string): string => relative(cwd, file).replace(/\\/g, "/");
    return {
      sourceFiles: files.map(relativeFile).sort(),
      consumers: (reverseEdges.get(resolve(cwd, declarationFile).replace(/\\/g, "/")) ?? []).map(relativeFile).sort(),
    } satisfies StaticImportConsumerScope;
  });
