const FILE_KIND_LITERALS = new Set(["production", "test", "generated", "auxiliary"]);

const literalValue = (text) => text.replace(/^['"`]|['"`]$/g, "");

/**
 * Project-local guard for the historical FileKind scatter. It deliberately
 * checks only a complete second value set, not individual role comparisons.
 */
export default {
  scope: "repository",
  requires: ["file-classification.v1"],
  targets: {
    include: ["packages/**/*.ts"],
    exclude: ["packages/core/src/domain/testGovernance.ts"],
    fileKinds: ["production"],
  },
  stages: {
    text: ({ files, text }) => files.filter((file) => {
      const source = text(file);
      return [...FILE_KIND_LITERALS].every((literal) => source.includes(literal));
    }),
    ast: {
      pattern: "[(string) @literal (template_string) @literal]",
      extract: (matches, file) => matches.flatMap((match) =>
        match.captures
          .filter((capture) => capture.name === "literal")
          .map((capture) => ({ _file: file, literal: literalValue(capture.text), line: capture.startLine }))),
    },
  },
  link: ({ records }) => {
    const grouped = new Map();
    for (const record of records) {
      if (typeof record._file !== "string" || typeof record.literal !== "string") continue;
      if (!FILE_KIND_LITERALS.has(record.literal)) continue;
      const literals = grouped.get(record._file) ?? new Set();
      literals.add(record.literal);
      grouped.set(record._file, literals);
    }
    return [...grouped.entries()]
      .filter(([, literals]) => [...FILE_KIND_LITERALS].every((literal) => literals.has(literal)))
      .map(([file, literals]) => ({
        ruleId: "file-kind-shadow-definition",
        file,
        message: "complete FileKind value set is redefined outside the domain authority; import FILE_KINDS/isFileKind instead",
        evidence: [...literals].sort().join(", "),
      }));
  },
};
