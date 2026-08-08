export default {
  scope: "file",
  targets: { languages: ["python"], include: ["*.py", "**/*.py"], fileKinds: ["production"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /\bexcept\b/.test(text(file))),
    ast: {
      pattern: "(except_clause (block) @body)",
      extract: (matches) => matches.flatMap((match) => {
        const body = match.captures.find((capture) => capture.name === "body");
        return body ? [{ body: body.text, line: body.startLine, endLine: body.endLine }] : [];
      }),
    },
  },
  link({ records }) {
    return records.flatMap((record) => String(record.body).trim() === "pass" ? [{
      ruleId: "silent-error-handling", file: record._file,
      message: "except block only passes and discards the exception",
      category: "correctness", severity: "warning", patternFamily: "silent-error-handling",
      suggestion: "Handle, rethrow, or explicitly document why this exception is intentionally ignored.",
      ...(typeof record.line === "number" ? { line: record.line } : {}),
      ...(typeof record.endLine === "number" ? { endLine: record.endLine } : {}),
      evidence: String(record.body),
    }] : []);
  },
};
