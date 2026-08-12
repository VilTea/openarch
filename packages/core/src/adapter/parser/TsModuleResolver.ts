import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { ModuleResolver } from "./ModuleResolver";
import { typeScriptConfigPathFor } from "../typescript/TypeScriptProject";

type CompilerOptionsState = ts.CompilerOptions | "invalid";

const configPathByImporterDir = new Map<string, string | null>();
const compilerOptionsByConfigPath = new Map<string, CompilerOptionsState>();

const configPathFor = (filePath: string): string | null => {
  const importerDir = dirname(filePath);
  if (configPathByImporterDir.has(importerDir)) return configPathByImporterDir.get(importerDir) ?? null;
  const configPath = typeScriptConfigPathFor(filePath) ?? null;
  // 只缓存成功结果（2026-08-12 修复，与 JavaModuleResolver 对齐）：tsconfig 可能
  // 在首次解析后出现，缓存 null 会让新增 tsconfig 的项目永久解析失败。
  if (configPath) configPathByImporterDir.set(importerDir, configPath);
  return configPath;
};

const compilerOptionsFor = (filePath: string): CompilerOptionsState => {
  const configPath = configPathFor(filePath);
  if (!configPath) return {};
  const cached = compilerOptionsByConfigPath.get(configPath);
  if (cached) return cached;

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    // 不缓存 "invalid"（2026-08-12 修复）：配置文件错误可能在修复后恢复。
    return "invalid";
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  compilerOptionsByConfigPath.set(configPath, parsed.options);
  return parsed.options;
};

/** Delegates TS/JS specifier semantics to the project's TypeScript compiler configuration. */
export const tsModuleResolver: ModuleResolver = {
  resolveLocal: (importerPath, source) => {
    const compilerOptions = compilerOptionsFor(importerPath);
    if (compilerOptions === "invalid") return [];

    const resolved = ts.resolveModuleName(source, importerPath, compilerOptions, ts.sys).resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport) return [];
    return [resolve(resolved.resolvedFileName)];
  },
};
