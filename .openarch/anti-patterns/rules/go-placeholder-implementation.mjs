export default {
  scope: "file",
  targets: { languages: ["go"], include: ["*.go", "**/*.go"], fileKinds: ["production"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /\bfunc\b/.test(text(file))),
    ast: {
      pattern: "[(function_declaration body: (block) @body) (method_declaration body: (block) @body)]",
      extract: (matches) => matches.flatMap((match) => {
        const body = match.captures.find((capture) => capture.name === "body")?.text;
        return body ? [{ body }] : [];
      }),
    },
  },
  link({ records }) {
    return records.flatMap((record) => String(record.body).replace(/\s/g, "") === "{}" ? [{
      ruleId: "placeholder-implementation", file: record._file,
      message: "callable body is empty; confirm this is not an unfinished implementation",
      category: "quality",
      severity: "warning",
      patternFamily: "placeholder-implementation",
      suggestion: "Implement the callable or document why this no-op body is intentional.",
      evidence: String(record.body),
    }] : []);
  },
};
