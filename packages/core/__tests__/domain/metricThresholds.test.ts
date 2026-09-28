import { describe, expect, it } from "vitest";
import { numericGateThresholdsInCondition } from "../../src/domain/metricCatalog";

/**
 * 阈值读取（校准 2026-09-25）。
 *
 * 报告必须能说出"已声明阈值 / 当前 P95"的倍数，而阈值唯一的权威来源就是 gate 条件本身。
 * 这里固定三件事：只认 gate 指标、方向可翻转、复合条件下阈值仍然唯一。
 * 该项与 `metricIdsInCondition` 同源，因此不引入第二套 CEL 解析。
 */
describe("numericGateThresholdsInCondition", () => {
  it("读出简单条件的阈值", () => {
    expect(numericGateThresholdsInCondition("max_func_branch > 6")).toEqual([
      { metricId: "max_func_branch", comparison: ">", threshold: 6 },
    ]);
    expect(numericGateThresholdsInCondition("crl_local >= 0.55")).toEqual([
      { metricId: "crl_local", comparison: ">=", threshold: 0.55 },
    ]);
  });

  it("复合条件下阈值仍然唯一（分类器不干扰）", () => {
    expect(numericGateThresholdsInCondition('path_class == "domain" && max_func_branch > 5')).toEqual([
      { metricId: "max_func_branch", comparison: ">", threshold: 5 },
    ]);
  });

  it("不把字符串字面量里的数字当成阈值", () => {
    expect(numericGateThresholdsInCondition('path_class == "v2" && crl_local > 0.4')).toEqual([
      { metricId: "crl_local", comparison: ">", threshold: 0.4 },
    ]);
  });

  it("反向写法被翻转成同一方向", () => {
    expect(numericGateThresholdsInCondition("6 < max_func_branch")).toEqual([
      { metricId: "max_func_branch", comparison: ">", threshold: 6 },
    ]);
    expect(numericGateThresholdsInCondition("0.5 >= crl_local")).toEqual([
      { metricId: "crl_local", comparison: "<=", threshold: 0.5 },
    ]);
  });

  it("非 gate 指标（report_only / retired / 未登记）不产生阈值", () => {
    // nesting_depth 是 report_only：即便写进条件也不允许作为 gate 阈值被报告。
    expect(numericGateThresholdsInCondition("nesting_depth > 3")).toEqual([]);
    expect(numericGateThresholdsInCondition("branch_count > 3")).toEqual([]);
    expect(numericGateThresholdsInCondition("not_a_metric > 3")).toEqual([]);
  });

  it("没有数字比较时不产生阈值", () => {
    expect(numericGateThresholdsInCondition("crl_local > exposure")).toEqual([]);
  });
});
