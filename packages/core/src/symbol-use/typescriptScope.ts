import { resolve } from "node:path";
import type ts from "typescript";
import type { SymbolUseDemandSelection } from "./demand";
import { symbolUseScopeFor, type SymbolUseFact, type SymbolUseScope } from "./types";

type Candidate = { readonly declaration: SymbolUseFact["declaration"] };

const TYPESCRIPT_DECLARATION_KINDS = [
  "function", "class", "method", "accessor", "class-property-function", "object-property-function",
  "interface-property", "interface-method", "type-property", "type-method",
] as const satisfies readonly SymbolUseFact["declaration"]["kind"][];

export const selectedTypeScriptSources = (
  cwd: string,
  sources: readonly ts.SourceFile[],
  selection: SymbolUseDemandSelection,
): readonly ts.SourceFile[] => !selection.namesByFile ? sources : sources.filter((source) =>
  selection.namesByFile?.has(resolve(cwd, source.fileName)) ?? false,
);

export const selectedTypeScriptCandidates = <T extends Candidate>(
  cwd: string,
  selection: SymbolUseDemandSelection,
  candidates: ReadonlyMap<string, T>,
): ReadonlyMap<string, T> => !selection.namesByFile ? candidates : new Map([...candidates].filter(([, candidate]) =>
  selection.namesByFile?.get(resolve(cwd, candidate.declaration.file))?.has(candidate.declaration.name.split(".").at(-1)!) ?? false,
));

export const typeScriptSymbolUseScope = (
  demand: boolean,
  governedFiles: number,
  selectedFiles: number,
): SymbolUseScope => symbolUseScopeFor(demand ? "demand" : "repository", governedFiles, selectedFiles, TYPESCRIPT_DECLARATION_KINDS);
