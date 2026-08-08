export default {
  requires: ["structure-metrics.v1"],
  stages: { ast: { pattern: "(identifier) @name" } },
  link: ({ records, facts }) => {
    const metrics = new Map((facts.structureMetrics.value ?? []).map((fact) => [fact.path, fact]));
    // Inspect raw facts such as maxFuncBranch/nestingDepth; do not recreate CRL, I_push or gate policy.
    return records.flatMap((record) => metrics.has(record._file) ? [] : []);
  },
};
