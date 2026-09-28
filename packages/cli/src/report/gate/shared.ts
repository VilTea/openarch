import { type GateTriggerMode, metricDefinition, metricIdsInCondition } from "@openarch/core";
import { type Locale, message } from "../../i18n";

export const bar = (component: number): string => "#".repeat(Math.round(Math.min(1, component / 0.2) * 12));

export const hasBurdenMetric = (condition: string): boolean =>
  metricIdsInCondition(condition).some((id) => id === "crl_local" || id === "exposure");

/**
 * 调查方向随策略 mode 变化（WARN 不是整改指令）：
 * 只有 enforce 总体产出裁决与调查方向；observe 总体只覆盖总体，报告不得给出整改指向。
 */
export const recommendations = (locale: Locale, condition: string, mode: GateTriggerMode): readonly string[] =>
  mode === "observe" ? [] : metricIdsInCondition(condition).flatMap((id) => {
    const recommendationId = metricDefinition(id)?.recommendationId;
    return recommendationId ? [message(locale, `gate.recommendation.${recommendationId}`)] : [];
  });
