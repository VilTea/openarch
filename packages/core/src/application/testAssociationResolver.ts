import { Effect } from "effect";
import type { FileAst } from "../domain/ast";
import { promoteStaticModuleAssociations, staticModuleAssociations, type TestModuleAssociation, type TestSymbolCallEvidence } from "../domain/testAssociations";
import type { ParserService } from "../port/ParserService";

/** Resolves S2 from explicit test imports while preserving unavailable parser facts as low evidence. */
export const resolveTestModuleAssociations = (
  parser: ParserService,
  testAst: FileAst,
  productionPaths: ReadonlySet<string>,
  calls: readonly TestSymbolCallEvidence[],
  exportedSymbolsByPath: Map<string, FileAst["exportedSymbols"]>,
) => Effect.gen(function* () {
  const associations = staticModuleAssociations(testAst.imports, productionPaths);
  for (const association of associations) {
    if (exportedSymbolsByPath.has(association.targetPath)) continue;
    const target = yield* Effect.either(parser.parse(association.targetPath));
    exportedSymbolsByPath.set(association.targetPath, target._tag === "Right" ? target.right.exportedSymbols : undefined);
  }
  return promoteStaticModuleAssociations(associations, calls, exportedSymbolsByPath);
});
