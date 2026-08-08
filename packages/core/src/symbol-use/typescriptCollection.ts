import type { SymbolUseDemand } from "../port/SymbolUseService";
import { hasCompleteTypeScriptProjectScope, loadTypeScriptProjects } from "../adapter/typescript/TypeScriptProject";
import { listProjectSourceFiles } from "../projectFiles";
import { selectSymbolUseDemand } from "./demand";
import { normalizeSymbolUseFacts } from "./normalization";
import { selectedTypeScriptCandidates, selectedTypeScriptSources, typeScriptSymbolUseScope } from "./typescriptScope";
import { collectCandidates, collectReferences, publicSymbols } from "./typescript";
import type { SymbolUseFact, SymbolUseReport } from "./types";

/** Compiler-backed orchestration of the common repository/demand symbol-use contract. */
export const collectTypeScriptSymbolUse = (cwd: string, language: "typescript" | "javascript" = "typescript", requestedDemand?: SymbolUseDemand): SymbolUseReport => {
  const sourceFiles = listProjectSourceFiles({ cwd, languages: [language], population: "production-governance" });
  const demand = selectSymbolUseDemand(cwd, sourceFiles, requestedDemand);
  const projects = loadTypeScriptProjects(cwd, sourceFiles);
  if (projects.length === 0 || projects.some((project) => project.parsed.errors.length > 0)) return {
    origin: { language, providerId: "typescript-symbol-use", evidenceSource: "compiler" },
    state: { availability: "unavailable", coverage: { declarations: "unavailable", repositoryReferences: "unavailable" }, reason: "tsconfig.json could not be read" },
    facts: [],
  };
  const facts = normalizeSymbolUseFacts(projects.flatMap(({ checker, sources }) => {
    const candidates = selectedTypeScriptCandidates(cwd, demand, collectCandidates(selectedTypeScriptSources(cwd, sources, demand), checker, publicSymbols(sources, checker), cwd));
    const references = collectReferences(sources, checker, candidates, cwd);
    return [...candidates.values()].map((candidate) => ({ language, declaration: candidate.declaration, repositoryReferences: references.get(candidate.identity) ?? [], publicSurface: candidate.publicSurface } satisfies SymbolUseFact));
  }));
  const completeScope = !requestedDemand && hasCompleteTypeScriptProjectScope(projects, sourceFiles);
  const reason = requestedDemand ? demand.reason : completeScope ? undefined : "some governed source files are outside the resolved TypeScript project";
  return {
    origin: { language, providerId: "typescript-symbol-use", evidenceSource: "compiler" },
    state: {
      availability: completeScope ? "available" : "partial",
      coverage: { declarations: completeScope ? "complete" : "partial", repositoryReferences: completeScope ? "complete" : "partial" },
      ...(reason ? { reason } : {}),
    },
    scope: typeScriptSymbolUseScope(Boolean(requestedDemand), sourceFiles.length, demand.declarationFiles.length), facts,
  };
};
