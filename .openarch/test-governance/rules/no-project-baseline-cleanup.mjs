// Dogfood 项目规则：测试不得直接清理仓库真实 .openarch/；必须使用隔离根目录。
export default {
  stages: {
    text: ({ files, text }) => files.filter((file) => {
      const source = text(file);
      return source.includes(".openarch") && (source.includes("rmSync") || source.includes("rm("));
    }),
    ast: {
      pattern: `
        (call_expression
          function: (identifier) @callee
          arguments: (arguments (string) @path)) @call
      `,
      extract: (matches) => matches.flatMap((match) => {
        const callee = match.captures.find((capture) => capture.name === "callee")?.text;
        const path = match.captures.find((capture) => capture.name === "path")?.text;
        return callee && path ? [{ callee, path }] : [];
      }),
    },
  },
  link: ({ records }) => records.flatMap((record) =>
    (record.callee === "rmSync" || record.callee === "rm") && typeof record.path === "string" && record.path.includes(".openarch")
      ? [{
        ruleId: "openarch.no-project-baseline-cleanup",
        kind: "project_baseline_cleanup",
        file: record._file,
        evidence: [`${record.callee}(${record.path})`],
        confidence: "confirmed",
      }]
      : [],
  ),
};
