export default {
  scope: "file",
  targets: { languages: ["java"], include: ["*.java", "**/*.java"], fileKinds: ["production"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /\b(?:public|protected|private|static|final|void|[A-Za-z_]\w*)\s+\w+\s*\([^{};]*\)\s*\{\s*\}/.test(text(file))),
    ast: {
      pattern: "(method_declaration body: (block) @body)",
      extract: (matches) => matches.flatMap((match) => {
        const body = match.captures.find((capture) => capture.name === "body");
        return body ? [{ body: body.text, line: body.startLine, endLine: body.endLine }] : [];
      }),
    },
  },
  link({ records }) {
    return records.flatMap((record) => String(record.body).replace(/\s/g, "") === "{}" ? [{
      ruleId: "placeholder-implementation", file: record._file,
      message: "method body is empty; confirm this is not an unfinished implementation",
      category: "quality", severity: "warning", patternFamily: "placeholder-implementation",
      suggestion: "Implement the method or document why this no-op body is intentional.",
      ...(typeof record.line === "number" ? { line: record.line } : {}),
      ...(typeof record.endLine === "number" ? { endLine: record.endLine } : {}),
      evidence: String(record.body),
    }] : []);
  },
};
