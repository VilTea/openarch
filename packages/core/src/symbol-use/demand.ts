import { resolve } from "node:path";
import type { SymbolUseDemand } from "../port/SymbolUseService";

export interface SymbolUseDemandSelection {
  readonly declarationFiles: readonly string[];
  readonly namesByFile?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly reason?: string;
}

/** Shared revision-owned selection for compiler and LSP providers. */
export const selectSymbolUseDemand = (
  cwd: string,
  sourceFiles: readonly string[],
  demand: SymbolUseDemand | undefined,
): SymbolUseDemandSelection => {
  if (!demand) return { declarationFiles: sourceFiles };
  const available = new Set(sourceFiles.map((file) => resolve(file)));
  const namesByFile = new Map<string, ReadonlySet<string>>();
  for (const declaration of demand.declarations) {
    const file = resolve(cwd, declaration.file);
    const names = new Set(declaration.names.filter(Boolean));
    // 空 names = 文件级兜底（--change-override 的 manual:file 无符号名，
    // 校准 2026-08-06）——仍进 declarationFiles，provider 查该文件全部声明。
    if (available.has(file)) namesByFile.set(file, names);
  }
  const declarationFiles = [...namesByFile.keys()].sort();
  return {
    declarationFiles,
    namesByFile,
    reason: `demand-driven semantic query selected ${declarationFiles.length}/${sourceFiles.length} governed declaration files; repository completeness was not evaluated`,
  };
};
