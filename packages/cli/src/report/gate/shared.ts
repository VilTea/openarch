import { metricDefinition, metricIdsInCondition } from "@openarch/core";
import { type Locale, message } from "../../i18n";

export const bar = (component: number): string => "#".repeat(Math.round(Math.min(1, component / 0.2) * 12));

export const hasBurdenMetric = (condition: string): boolean =>
  metricIdsInCondition(condition).some((id) => id === "crl_local" || id === "exposure");

export const recommendations = (locale: Locale, condition: string): readonly string[] =>
  metricIdsInCondition(condition).flatMap((id) => {
    const recommendationId = metricDefinition(id)?.recommendationId;
    return recommendationId ? [message(locale, `gate.recommendation.${recommendationId}`)] : [];
  });
