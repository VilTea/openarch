import type { FileAst } from "../domain/ast";
import type { StageRecord } from "./types";

/** The sole projection from parser-confirmed imports into script-facing static import facts. */
export const staticImportSources = (ast: FileAst): readonly string[] => ast.imports.map((ref) => ref.source);

export const staticImportRecords = (file: string, ast: FileAst): readonly StageRecord[] =>
  staticImportSources(ast).map((source) => ({ _file: file, source, language: ast.language }));
