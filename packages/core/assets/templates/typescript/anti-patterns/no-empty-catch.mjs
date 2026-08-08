export default {
  scope: "file",
  targets: { languages: ["typescript", "javascript"], include: ["*.ts", "**/*.ts", "*.tsx", "**/*.tsx", "*.js", "**/*.js", "*.jsx", "**/*.jsx", "*.mjs", "**/*.mjs", "*.cjs", "**/*.cjs"], fileKinds: ["production"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => text(file).includes("catch")),
    ast: {
      pattern: "(catch_clause body: (statement_block) @body)",
      extract: (matches) => matches.flatMap((match) => {
        const body = match.captures.find((capture) => capture.name === "body")?.text;
        return body ? [{ body }] : [];
      }),
    },
  },
  link({ records }) {
    return records.flatMap((record) => record.body?.replace(/\s/g, "") === "{}" ? [{
      ruleId: "no-empty-catch", file: record._file, message: "empty catch block discards an error",
      category: "correctness", severity: "warning", patternFamily: "silent-error-handling",
      suggestion: "Handle, rethrow, or explicitly document why this error is intentionally ignored.", evidence: record.body,
    }] : []);
  },
};
