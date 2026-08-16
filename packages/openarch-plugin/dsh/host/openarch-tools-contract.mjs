/**
 * OpenArch DSH 插件 — openarch_contract 工具构造器（Host）。
 *
 * 消费 `openarch contract --json`（contract-catalog-json-v1）：外部插件
 * 启动时感知各可消费机器契约的当前版本。本插件持有的版本认识见
 * openarch-contracts.mjs；不认识的目录 schema 或契约版本一律 fail-closed。
 */
import { runCli, sessionCwdOf, tailChars, verdictOf } from "./openarch-tools-run.mjs";
import { renderContractText } from "./openarch-tools-render.mjs";
import { KNOWN_CONTRACTS, projectContractCatalog } from "./openarch-contracts.mjs";

const parseJson = (text) => {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** openarch_contract：只读契约目录（秒级）。 */
export function buildContractTool(deps) {
  const { ctx, options } = deps;
  return {
    name: "openarch_contract",
    description: "读取上游 OpenArch 机器契约目录（contract --json）：各可消费 JSON 契约的当前版本与 openarch 版本。外部插件据此感知契约版本；本插件对未知契约版本 fail-closed。",
    parameters: {},
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          exitCode: { type: "integer" },
          verdict: { type: "string", enum: ["PASS", "WARN", "BLOCK", "ERROR"] },
          command: { type: "string" },
          catalog: { type: "object", additionalProperties: true },
          report: { type: "string" },
          stderr: { type: "string" },
          error: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: renderContractText(value) }],
    },
    execute: async (_args, exec) => {
      const cwd = sessionCwdOf(exec, options);
      const commandArgs = ["contract", "--json"];
      const command = [options.openarchBin, ...commandArgs].join(" ");
      const result = await runCli(ctx, options, commandArgs, 60_000, cwd);
      if (!result.ok) {
        return { ok: false, verdict: "ERROR", error: `无法运行 openarch 二进制: ${result.error}`, command };
      }
      const parsed = parseJson(result.stdout);
      if (parsed === null) {
        const error = result.exitCode !== null && result.exitCode !== undefined && result.exitCode !== 0
          ? `已安装 openarch 二进制不支持 contract --json（exit ${result.exitCode}，可能版本过旧；请先升级/重装 openarch）。原始输出见 report。`
          : "contract --json 输出不是合法 JSON（已安装二进制与插件契约漂移？）。原始输出见 report。";
        return {
          ok: true,
          exitCode: result.exitCode,
          verdict: verdictOf(result.exitCode),
          command,
          error,
          report: tailChars(result.stdout, 8_000),
          stderr: tailChars(result.stderr, 2_000),
        };
      }
      const catalog = projectContractCatalog(parsed);
      if (catalog === null) {
        return {
          ok: true,
          exitCode: result.exitCode,
          verdict: verdictOf(result.exitCode),
          command,
          error: `契约目录 schema 不识别（schema=${String(parsed.schema ?? "缺失")}，本插件认识 ${KNOWN_CONTRACTS.catalog}），fail-closed 不静默解析。原始输出见 report。`,
          report: tailChars(result.stdout, 8_000),
          stderr: tailChars(result.stderr, 2_000),
        };
      }
      return {
        ok: true,
        exitCode: result.exitCode,
        verdict: verdictOf(result.exitCode),
        command,
        catalog,
        report: tailChars(result.stdout, 8_000),
        stderr: tailChars(result.stderr, 2_000),
      };
    },
    presentCall: () => ({ card: "generic", title: "OpenArch 机器契约目录", kind: "read", rawInput: "openarch contract --json" }),
  };
}
