// 项目测试治理脚本执行器：脚本只能发现事实，source 由引擎注入，策略在外层决定 gate 动作。
import { basename } from "node:path";
import type { ParserService } from "../port/ParserService";
import { TestFindingInputSchema } from "../validation/schemas";
import type { TestFinding, TestFindingInput } from "../domain/testGovernance";
import { executeStagedScript } from "../staged-analysis/engine";
import { isStagedRuleContract, type StageExecution, type StagedRule } from "../staged-analysis/types";
import { loadDefaultExport, type ScriptImport } from "../script-runtime/loadDefaultExport";
import type { ProjectFacts } from "../script-runtime/projectFacts";

export type TestFindingScript = StagedRule<TestFindingInput>;

export interface TestScriptResult {
  readonly findings: readonly TestFinding[];
  readonly error?: string;
  readonly unavailable?: string;
  readonly stages?: Pick<StageExecution, "inputFiles" | "targetFiles" | "candidateFiles" | "records">;
}

const log = (...args: unknown[]) => console.error("[openarch:test-rule]", ...args);

export const isTestFindingScript = (value: unknown): value is TestFindingScript => {
  return isStagedRuleContract(value);
};

const withTimeout = <T>(work: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`脚本超时（${timeoutMs}ms）`)), timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

/**
 * 执行受信任项目脚本。脚本只得到文件清单、只读 query 和 logger；输出逐项 Zod 校验。
 * 运行时隔离不是本层职责：不受信任脚本必须由宿主/CI 沙箱隔离。
 */
export const executeTestFindingScript = async (
  mjsPath: string,
  files: readonly string[],
  parser: ParserService,
  options: {
    readonly timeoutMs?: number;
    readonly importFn?: ScriptImport;
    readonly facts?: ProjectFacts;
  } = {},
): Promise<TestScriptResult> => {
  const loaded = await loadDefaultExport(mjsPath, options.importFn);
  if (loaded.error) return { findings: [], error: loaded.error };
  if (!isTestFindingScript(loaded.value)) {
    return { findings: [], error: `${mjsPath}: 必须 export default { stages, link }` };
  }
  const script = loaded.value;

  try {
    const stages = await withTimeout((async () => {
      const execution = await executeStagedScript(script, files, parser, { facts: options.facts, log });
      return execution;
    })(), options.timeoutMs ?? 5_000);
    if (stages.error) return { findings: [], error: `${mjsPath}: ${stages.error}` };
    if (stages.unavailable) return { findings: [], unavailable: stages.unavailable };
    const source = basename(mjsPath);
    const findings = stages.output.map((finding) => ({ ...TestFindingInputSchema.parse(finding), source }));
    return { findings, stages: stages.stages };
  } catch (error) {
    return { findings: [], error: `${mjsPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
};
