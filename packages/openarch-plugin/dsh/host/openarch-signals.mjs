/**
 * OpenArch DSH 插件 — 治理信号层（Host）。
 *
 * 把 OpenArch 的本地事实注入每个 model step 的系统提示：
 * - systemPrompt section（order 90：persona 之后、工具指导 100–199 之前）
 * - 文本是每步装配时求值的快照简报，只在项目已初始化时非空；
 *   未初始化/未采集到时返回空串（装配会丢弃空 section），不污染提示。
 * - 定期后台刷新（默认 120s）；openarch-tools 每次执行命令后也会
 *   invalidate，下一次装配自然拿到新事实。
 *
 * 只报告事实，不替用户裁决 —— 与 openarch skill 的"报告消费纪律"一致。
 */
import { strictConfig } from "./openarch-contract.mjs";
import { createGovernanceCache, DEFAULTS, renderGovernanceBrief } from "./openarch-state.mjs";

export const name = "openarch-signals";

/** systemPrompt 与 timer 都是硬依赖：本插件只做"常驻信号"，缺一不可。 */
export const inject = ["systemPrompt", "timer"];

const pickConfig = (config = {}) => {
  const clean = strictConfig(config);
  return {
    ...DEFAULTS,
    ...clean,
    stateTtlMs: typeof clean.stateTtlMs === "number" ? clean.stateTtlMs : DEFAULTS.stateTtlMs,
    refreshMs: typeof clean.refreshMs === "number" ? clean.refreshMs : 120_000,
    cwd: typeof clean.cwd === "string" && clean.cwd.length > 0 ? clean.cwd : process.cwd(),
  };
};

export function apply(ctx, config) {
  const options = pickConfig(config);
  const cache = createGovernanceCache(options);

  // 立即后台采集一次；失败静默（fail-closed：没事实就不注入，下轮重试）。
  cache.refresh().catch(() => {});

  // 周期刷新；ctx.interval 返回 disposer，随 fiber 停止自动清理。
  ctx.interval(() => {
    cache.refresh().catch(() => {});
  }, options.refreshMs);

  ctx.systemPrompt.section({
    name: "openarch:governance",
    order: 90,
    text: () => {
      const state = cache.snapshot();
      if (!state || !state.initialized) return "";
      return renderGovernanceBrief(state, state.config?.locale ?? "zh");
    },
  });
}
