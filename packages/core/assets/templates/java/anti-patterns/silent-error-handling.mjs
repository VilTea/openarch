export default {
  scope: "file",
  targets: { languages: ["java"], include: ["*.java", "**/*.java"], fileKinds: ["production"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /\bcatch\b/.test(text(file))),
    ast: {
      pattern: "(catch_clause body: (block) @body)",
      extract: (matches) => matches.flatMap((match) => {
        const body = match.captures.find((capture) => capture.name === "body");
        return body ? [{ body: body.text, line: body.startLine, endLine: body.endLine }] : [];
      }),
    },
  },
  link({ records }) {
    return records.flatMap((record) => String(record.body).replace(/\s/g, "") === "{}" ? [{
      ruleId: "silent-error-handling", file: record._file,
      message: "empty catch block discards an exception",
      category: "correctness", severity: "warning", patternFamily: "silent-error-handling",
      suggestion: "Handle, rethrow, or explicitly document why this exception is intentionally ignored.",
      ...(typeof record.line === "number" ? { line: record.line } : {}),
      ...(typeof record.endLine === "number" ? { endLine: record.endLine } : {}),
      evidence: String(record.body),
    }] : []);
  },
};
