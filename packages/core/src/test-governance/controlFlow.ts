import type { QueryCapture, QueryMatch } from "../port/ParserService";

export interface TestBodyRange {
  readonly startIndex?: number;
  readonly endIndex?: number;
}

const capture = (match: QueryMatch, name: string): QueryCapture | undefined =>
  match.captures.find((item) => item.name === name);

const isInside = (inner: Required<TestBodyRange>, outer: Required<TestBodyRange>): boolean =>
  inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex;

/** Captures structurally owned by one recognised test body, excluding nested function/lambda bodies. */
export const capturesInTestBody = (
  body: TestBodyRange,
  matches: readonly QueryMatch[],
  nestedFunctions: readonly QueryMatch[],
  captureName: string,
): readonly QueryCapture[] => {
  if (body.startIndex === undefined || body.endIndex === undefined) return [];
  const testBody = { startIndex: body.startIndex, endIndex: body.endIndex };
  const excludedRanges = nestedFunctions.flatMap((match) => {
    const nested = capture(match, "nested");
    if (nested?.startIndex === undefined || nested.endIndex === undefined) return [];
    const range = { startIndex: nested.startIndex, endIndex: nested.endIndex };
    return isInside(range, testBody) ? [range] : [];
  });
  return matches.flatMap((match) => {
    const item = capture(match, captureName);
    if (item?.startIndex === undefined || item.endIndex === undefined) return [];
    const range = { startIndex: item.startIndex, endIndex: item.endIndex };
    return isInside(range, testBody) && !excludedRanges.some((excluded) => isInside(range, excluded)) ? [item] : [];
  });
};

/**
 * Provider owns the grammar queries and weight labels. Core only enforces the ownership boundary:
 * a branch inside a nested function/lambda never inflates the enclosing recognised test body.
 */
export const controlFlowInTestBody = (
  body: TestBodyRange,
  controlFlow: readonly QueryMatch[],
  nestedFunctions: readonly QueryMatch[],
): number | undefined => {
  if (body.startIndex === undefined || body.endIndex === undefined) return undefined;
  const ownedFull = new Set(capturesInTestBody(body, controlFlow, nestedFunctions, "full"));
  const ownedCases = new Set(capturesInTestBody(body, controlFlow, nestedFunctions, "case"));

  return controlFlow.reduce((total, match) => {
    const branch = capture(match, "full") ?? capture(match, "case");
    if (!branch || (!ownedFull.has(branch) && !ownedCases.has(branch))) return total;
    return total + (ownedCases.has(branch) ? 0.3 : 1);
  }, 0);
};
