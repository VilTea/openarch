const normalizeLiteral = (text) => text.replace(/^['"`]|['"`]$/g, "");

const isHardcodedProjectShape = (literal) =>
  /^packages\/(?:\*\*|[^/]+)/.test(literal)
  || /^packages\/\*\*\/\*\.[a-z*]+$/i.test(literal);

export default {
  scope: "repository",
  // This rule governs runtime implementation discovery, not this repository's
  // release/package configuration or the linter configuration that governs it.
  targets: { include: ["packages/**/src/**", "packages/cli/bin/**"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => text(file).includes("packages/")),
    ast: {
      pattern: "[(string) @literal (template_string) @literal]",
      extract: (matches, file) =>
      matches.flatMap((match) =>
        match.captures
          .filter((capture) => capture.name === "literal")
          .map((capture) => ({
            literal: normalizeLiteral(capture.text),
            line: capture.startLine,
            file,
          }))),
    },
  },
  link({ records }) {
    return records
      .filter((record) => typeof record.literal === "string" && isHardcodedProjectShape(record.literal))
      .flatMap((record) => {
        const file = typeof record._file === "string" ? record._file : typeof record.file === "string" ? record.file : undefined;
        return file ? [{
          ruleId: "hardcoded-project-shape",
          file,
          message: "hardcoded project path/glob couples generic logic to one repository shape; route through projectFiles/config instead",
          evidence: `${record.literal}${typeof record.line === "number" ? ` @L${record.line}` : ""}`,
        }] : [];
      });
  },
};
