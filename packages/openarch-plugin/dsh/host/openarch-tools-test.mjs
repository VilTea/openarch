/**
 * OpenArch DSH 插件 — openarch_test 工具构造器（Host）。
 *
 * 消费 `openarch test --json`（test-governance-json-v1 契约）与
 * `openarch test --list --json`（test-governance-provider-list-v1 契约）。
 * 治理只读观察：只报告覆盖/建议，绝不自动启用 provider 或据此新增 BLOCK。
 * 评估结果投影进状态快照（testGovernance 槽），dashboard 显示最近一次观察。
 */
import { runCli, sessionCwdOf, tailChars, verdictOf } from "./openarch-tools-run.mjs";
import { renderTestText } from "./openarch-tools-render.mjs";
import { KNOWN_CONTRACTS, isKnownProviderListSchema, isKnownTestGovernanceSchema } from "./openarch-contracts.mjs";

/** openarch_test 的 canonical 输出 schema（与 manifest.tools 同步）。 */
export const TEST_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    exitCode: { type: "integer" },
    verdict: { type: "string", enum: ["PASS", "WARN", "BLOCK", "ERROR"] },
    command: { type: "string" },
    list: { type: "boolean" },
    providers: { type: "array" },
    testGovernance: { type: "object", additionalProperties: true },
    report: { type: "string" },
    stderr: { type: "string" },
    error: { type: "string" },
  },
};

/**
 * 把 test --json 投影成有界治理观察：dashboard/状态槽只留决策与边界事实，
 * 文件清单/关联边等大节不进常驻快照（观察面由 schema 版本自己演化）。
 */
export function projectTestGovernance(value) {
  if (!value || typeof value !== "object") return null;
  const collection = value.collection ?? {};
  const coverage = collection.coverage ?? {};
  const decision = value.decision ?? {};
  return {
    schema: typeof value.schema === "string" ? value.schema : null,
    verdict: typeof value.verdict === "string" ? value.verdict : null,
    decision: {
      findingCount: typeof decision.findingCount === "number" ? decision.findingCount : null,
      triggered: Array.isArray(decision.triggered) ? decision.triggered.slice(0, 20) : [],
      errors: Array.isArray(decision.errors) ? decision.errors.slice(0, 10) : [],
    },
    coverage: {
      status: typeof coverage.status === "string" ? coverage.status : null,
      reasons: Array.isArray(coverage.reasons) ? coverage.reasons.slice(0, 8) : [],
      testFiles: typeof coverage.testFiles === "number" ? coverage.testFiles : null,
      unbaselinedTestFiles: typeof coverage.unbaselinedTestFiles === "number" ? coverage.unbaselinedTestFiles : null,
      providerHandledTestFiles: typeof coverage.providerHandledTestFiles === "number" ? coverage.providerHandledTestFiles : null,
      unrecognizedTestFiles: typeof coverage.unrecognizedTestFiles === "number" ? coverage.unrecognizedTestFiles : null,
      failedTestFiles: typeof coverage.failedTestFiles === "number" ? coverage.failedTestFiles : null,
    },
    providers: Array.isArray(collection.providers) ? collection.providers.slice(0, 12).map((p) => ({
      providerId: typeof p?.providerId === "string" ? p.providerId : null,
      status: typeof p?.status === "string" ? p.status : null,
      candidates: typeof p?.candidates === "number" ? p.candidates : null,
      handled: typeof p?.handled === "number" ? p.handled : null,
      missingBaseline: typeof p?.missingBaseline === "number" ? p.missingBaseline : null,
      failed: typeof p?.failed === "number" ? p.failed : null,
    })) : [],
    summaries: Array.isArray(collection.summaries) ? collection.summaries.slice(0, 12) : [],
    suggestedAdapters: collection.suggestedAdapters ?? null,
    bloat: value.bloat ?? null,
  };
}

const parseJson = (text) => {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * 已安装的 openarch 二进制是插件唯一权威（插件面向分发，不回退仓库路径）。
 * 按退出码区分失败面：exit≠0 且输出非 JSON → 命令缺失/版本过旧；
 * exit=0 且输出非 JSON → 二进制与插件契约漂移。原始输出恒保留在 report。
 */
const parseFailureHint = (exitCode, command) => {
  if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
    return `已安装 openarch 二进制不支持 ${command}（exit ${exitCode}，可能版本过旧；请先升级/重装 openarch）。原始输出见 report。`;
  }
  return `${command} 输出不是合法 JSON（已安装二进制与插件契约漂移？）。原始输出见 report。`;
};

/** openarch_test：list 只列 provider；默认跑 test --json（可加 bloat）。 */
export function buildTestTool(deps) {
  const { ctx, options, caches } = deps;
  return {
    name: "openarch_test",
    description: "运行 OpenArch 测试治理评估（只读观察）：覆盖状态、provider 处理面、适配器建议与 TEST_BLOAT；list 只列已注册 provider。以已安装 openarch 二进制为准（需支持 test --json，旧版请先升级）。结果只作治理建议，绝不自动启用 provider 或据此新增 BLOCK。",
    parameters: {
      type: "object",
      properties: {
        list: { type: "boolean", description: "只列出已注册测试治理 provider（test --list --json）。" },
        bloat: { type: "boolean", description: "计算测试膨胀指标 TEST_BLOAT（更慢）。" },
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: 600_000,
    output: {
      schema: TEST_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: renderTestText(value) }],
    },
    execute: async (args, exec) => {
      const list = args?.list === true;
      const cwd = sessionCwdOf(exec, options);
      const commandArgs = ["test", "--json", ...(list ? ["--list"] : args?.bloat === true ? ["--bloat"] : [])];
      const timeoutMs = list ? 60_000 : 600_000;
      const result = await runCli(ctx, options, commandArgs, timeoutMs, cwd);
      const command = [options.openarchBin, ...commandArgs].join(" ");
      if (!result.ok) {
        return { ok: false, verdict: "ERROR", list, error: result.error, command };
      }
      if (list) {
        const parsed = parseJson(result.stdout);
        if (parsed !== null && !isKnownProviderListSchema(parsed.schema)) {
          return {
            ok: true,
            exitCode: result.exitCode,
            verdict: verdictOf(result.exitCode),
            command,
            list,
            error: `test --list --json 契约版本不识别（schema=${String(parsed.schema ?? "缺失")}，本插件认识 ${KNOWN_CONTRACTS.testGovernanceProviderListJson}），fail-closed 不静默解析。原始输出见 report。`,
            report: tailChars(result.stdout, 8_000),
            stderr: tailChars(result.stderr, 2_000),
          };
        }
        const providers = parsed && Array.isArray(parsed.providers) ? parsed.providers : [];
        return {
          ok: true,
          exitCode: result.exitCode,
          verdict: verdictOf(result.exitCode),
          command,
          list,
          providers,
          ...(parsed !== null ? {} : { error: parseFailureHint(result.exitCode, "test --list --json") }),
          report: tailChars(result.stdout, 8_000),
          stderr: tailChars(result.stderr, 2_000),
        };
      }
      const parsed = parseJson(result.stdout);
      if (parsed !== null && !isKnownTestGovernanceSchema(parsed.schema)) {
        caches.invalidate(cwd);
        return {
          ok: true,
          exitCode: result.exitCode,
          verdict: verdictOf(result.exitCode),
          command,
          list,
          error: `test --json 契约版本不识别（schema=${String(parsed.schema ?? "缺失")}，本插件认识 ${KNOWN_CONTRACTS.testGovernanceJson}），fail-closed 不静默解析。原始输出见 report。`,
          report: tailChars(result.stdout, 16_000),
          stderr: tailChars(result.stderr, 2_000),
        };
      }
      const testGovernance = projectTestGovernance(parsed);
      if (testGovernance && typeof deps.onTestGovernance === "function") deps.onTestGovernance(testGovernance, cwd);
      caches.invalidate(cwd);
      return {
        ok: true,
        exitCode: result.exitCode,
        verdict: verdictOf(result.exitCode),
        command,
        list,
        ...(testGovernance
          ? { testGovernance }
          : { error: parseFailureHint(result.exitCode, "test --json") }),
        report: tailChars(result.stdout, 16_000),
        stderr: tailChars(result.stderr, 2_000),
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: args?.list ? "OpenArch 测试治理 provider 列表" : "OpenArch 测试治理评估",
      kind: "execute",
      rawInput: args && Object.keys(args).some((key) => args[key]) ? args : undefined,
    }),
  };
}
