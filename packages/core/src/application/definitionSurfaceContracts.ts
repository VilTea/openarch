// Definition-surface contract layer (report-only enforcement candidates).
// A contract declares a role file family and the shared authority module it
// must import. The fact layer recalls "these files look similar"; this layer
// says whether a declared contract is being bypassed.
//
// This module is intentionally project-agnostic. Callers pass project-declared
// contracts (from a project script, configuration, or programmatic API); core
// never hard-codes a specific project's file names or module names.
import { Effect } from "effect";
import { minimatch } from "minimatch";
import type { ImportRef } from "../domain/ast";
import type { ParserService } from "../port/ParserService";
import { parserStrategyForFile } from "../adapter/parser/LanguageRegistry";
import { normalizeRepositoryPath } from "../script-runtime/projectFacts";

export interface DefinitionSurfaceContract {
  readonly id: string;
  readonly description: string;
  readonly roleGlobs: readonly string[];
  readonly authorityGlobs: readonly string[];
  /** Module specifier that role files must import from the authority. */
  readonly requiredImport: string;
}

export interface DefinitionSurfaceContractFinding {
  readonly contractId: string;
  readonly file: string;
  readonly message: string;
  readonly authorityPath: string;
}

const matchesAny = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => minimatch(path, pattern, { dot: true }));

/** 契约判定的唯一依据是解析器确认的静态导入说明符（`FileAst.imports[].source`，
 *  即 `static-imports.v1` 的同源事实；见 `staged-analysis/staticImports.ts`）。
 *  `contract.requiredImport` 在这里是**比较对象**，不是模式片段——因此不再需要转义，
 *  也不再把注释/字符串里的 `from "..."` 当作已接入。 */
const importsModule = (imports: readonly ImportRef[], requiredImport: string): boolean =>
  imports.some((ref) => ref.source === requiredImport);

/** 角色文件的解析结果：`imports` = 已接入判定依据；`unparseable` = 有语法支持但解析失败
 *  （读不到、WASM 不可用、语法错误），必须 fail-closed；`unsupported` = 该扩展名本就
 *  没有语法支持（例如角色 glob 覆盖到 Markdown），不是契约违规。 */
const parseImports = (parser: ParserService, file: string): { readonly imports?: readonly ImportRef[]; readonly unparseable: boolean } => {
  if (!parserStrategyForFile(file)) return { unparseable: false };
  try {
    return { imports: Effect.runSync(parser.parse(file)).imports, unparseable: false };
  } catch {
    return { unparseable: true };
  }
};

/** Checks declared definition-surface contracts.
 *
 *  判定通道是语法：角色文件的 import 说明符取自 `ParserService.parse` 的 `FileAst.imports`。
 *  被注释掉的 import（`// import { x } from "../authority"`）不产生 import 节点，
 *  字符串字面量里的 `from "..."` 同样不算接入。
 *
 *  A contract only applies when at least one authority file matching `authorityGlobs`
 *  exists in the project. Role files the parser cannot read or parse **fail closed**：
 *  它们产出一条"无法判定"的 finding——"无法判定"不能被静默当成"没有绕过契约"
 *  （该模块 report-only，但漏报方向是治理机制最不能承受的方向）。 */
export const assessDefinitionSurfaceContracts = (
  cwd: string,
  files: readonly string[],
  contracts: readonly DefinitionSurfaceContract[],
  parser: ParserService,
): readonly DefinitionSurfaceContractFinding[] => {
  const entries = files.map((file) => ({ file, repositoryPath: normalizeRepositoryPath(file, cwd) }));
  const findings: DefinitionSurfaceContractFinding[] = [];
  for (const contract of contracts) {
    const authority = entries.find((entry) => matchesAny(entry.repositoryPath, contract.authorityGlobs));
    // Without an authority there is no "should converge to" target.
    if (!authority) continue;
    const authorityPath = authority.repositoryPath;
    for (const entry of entries) {
      if (!matchesAny(entry.repositoryPath, contract.roleGlobs)) continue;
      if (entry.repositoryPath === authority.repositoryPath) continue;
      const parsed = parseImports(parser, entry.file);
      if (parsed.unparseable) {
        findings.push({
          contractId: contract.id,
          file: entry.repositoryPath,
          message: `契约 ${contract.id} 无法判定：角色文件无法读取或解析`,
          authorityPath,
        });
        continue;
      }
      // 无语法支持的角色文件无法判定，但也无法声明它"绕过了契约"：不产出 finding，
      // 与旧实现"读不到就跳过"的可观测行为一致（差别只在无法判定的**有语法文件**）。
      if (!parsed.imports || importsModule(parsed.imports, contract.requiredImport)) continue;
      findings.push({
        contractId: contract.id,
        file: entry.repositoryPath,
        message: `未接入共享模块 ${contract.requiredImport}；疑似平行实现`,
        authorityPath,
      });
    }
  }
  return findings;
};
