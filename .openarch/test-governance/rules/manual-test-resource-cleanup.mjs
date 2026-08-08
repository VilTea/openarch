// Project-specific review signal: manual cleanup inside a provider-confirmed test body.
// It deliberately does not claim a leak: try/finally and lifecycle ownership need local review.
export default {
  requires: ["test-case-spans.v1"],
  targets: { fileKinds: ["test"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /\b(?:rmSync|rm|unlinkSync|unlink)\s*\(/.test(text(file))),
    ast: {
      pattern: `
        (call_expression
          function: (identifier) @callee) @call
      `,
      extract: (matches) => matches.flatMap((match) => {
        const callee = match.captures.find((capture) => capture.name === "callee")?.text;
        const call = match.captures.find((capture) => capture.name === "call");
        return callee && call && ["rmSync", "rm", "unlinkSync", "unlink"].includes(callee)
          ? [{ callee, line: call.startLine }]
          : [];
      }),
    },
  },
  link: ({ records, facts }) => {
    const spans = facts.testCaseSpans.value ?? [];
    return records.flatMap((record) => spans
      .filter((span) => span.file === record._file && typeof record.line === "number"
        && record.line >= span.startLine && record.line <= span.endLine)
      .map((span) => ({
        ruleId: "openarch.manual-test-resource-cleanup",
        kind: "manual_test_resource_cleanup",
        file: record._file,
        testName: span.name,
        evidence: [`${record.callee}() in provider-confirmed test body`, `provider=${span.providerId}`],
        confidence: "low",
      })));
  },
};
