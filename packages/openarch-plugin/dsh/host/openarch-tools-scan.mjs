/**
 * OpenArch DSH 插件 — openarch_scan 工具构造器（Host）。
 *
 * 优先对接 DSH `jobs` 注册表（kind: "openarch"）作为后台任务运行；
 * 无 jobs 服务时降级为同步执行（同 gate 形状的结果）。
 * 后台任务结算后回调 cache.invalidate()——长任务跑完后看板不必等 TTL
 * 才知道基线变了。支持 --report 把扫描范围/排除段透给模型。
 */
import { createTail, makeScanJob, runCli, sessionCwdOf, tailChars, verdictOf } from "./openarch-tools-run.mjs";
import { renderGateText } from "./openarch-tools-render.mjs";

const SCAN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["background"],
  properties: {
    background: { type: "boolean" },
    jobId: { type: "string" },
    ok: { type: "boolean" },
    exitCode: { type: "integer" },
    verdict: { type: "string", enum: ["PASS", "WARN", "BLOCK", "ERROR"] },
    command: { type: "string" },
    report: { type: "string" },
    error: { type: "string" },
  },
};

/** openarch_scan：后台任务优先，无 jobs 服务时同步执行。 */
export function buildScanTool(deps) {
  const { ctx, options, caches } = deps;
  const commandArgsOf = (args) => ["scan", ...(args?.rebuild ? ["--rebuild"] : []), ...(args?.report ? ["--report"] : [])];
  const commandOf = (args) => [options.openarchBin, ...commandArgsOf(args)].join(" ");
  const syncRun = async (args, cwd) => {
    const result = await runCli(ctx, options, commandArgsOf(args), 900_000, cwd);
    if (!result.ok) return { background: false, ok: false, verdict: "ERROR", error: result.error, command: commandOf(args) };
    return {
      background: false,
      ok: true,
      exitCode: result.exitCode,
      verdict: verdictOf(result.exitCode),
      command: commandOf(args),
      report: tailChars(result.stdout, 16_000),
    };
  };
  return {
    name: "openarch_scan",
    description: "重建/更新 OpenArch 基线。作为后台任务运行并返回 job id（用 job_output 收集、job_kill 取消）；后台任务服务不可用时同步执行。配置 structural_policies/file_kinds 变化后应传 rebuild: true。",
    parameters: {
      rebuild: { type: "boolean", description: "强制全量重建（--rebuild；配置变化后必须，增量 scan 按内容 SHA-256 短路、不感知配置）。" },
      report: { type: "boolean", description: "追加扫描范围/排除段/解析失败的结构复盘报告（--report）。" },
    },
    isConcurrencySafe: () => false,
    timeoutMs: 900_000,
    output: {
      schema: SCAN_OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value.background) {
          return [{ type: "text", text: `openarch scan 已作为后台任务启动：${value.jobId}。用 job_output 收集输出，job_kill 取消。` }];
        }
        return [{ type: "text", text: renderGateText(value, "scan") }];
      },
    },
    execute: (args, exec) => {
      const cwd = sessionCwdOf(exec, options);
      caches.invalidate(cwd);
      const jobs = ctx.get("jobs");
      if (jobs && typeof jobs.start === "function") {
        const tail = createTail(64 * 1024);
        const jobId = jobs.start({
          kind: "openarch",
          label: commandOf(args),
          owner: exec.agent,
          run: () => {
            const hooks = makeScanJob(ctx, { ...options, cwd }, commandArgsOf(args), tail);
            // 长任务结算后立即让该工作区的状态缓存重采（看板/信号不必等 TTL）。
            hooks.done.then(() => caches.invalidate(cwd)).catch(() => {});
            return hooks;
          },
        });
        return { background: true, jobId: String(jobId) };
      }
      return syncRun(args, cwd);
    },
    presentCall: (args) => ({
      card: "generic",
      title: args?.rebuild ? "重建 OpenArch 基线" : "更新 OpenArch 基线",
      kind: "execute",
      rawInput: commandOf(args),
    }),
  };
}
