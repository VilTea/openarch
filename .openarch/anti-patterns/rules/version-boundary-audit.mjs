const unquote = (text) => text.replace(/^['"`]|['"`]$/g, "");
const isVersionIdentity = (value) => /^[a-z][a-z0-9-]*-v[1-9][0-9]*$/.test(value);
const isClassifiedPersistedBoundary = (values) => values.has("persisted")
  && values.has("reject")
  && (values.has("legacy-supported") || values.has("baseline-index") || values.has("symbol-calibration-profile"));

/**
 * Report-only inventory. A durable model must declare its storage and explicit
 * rejection/fallback policy through the shared persisted-boundary contract.
 * Syntax cannot prove that a boundary is necessary, so unclassified values
 * remain investigation candidates rather than gate failures.
 */
export default {
  scope: "repository",
  targets: { include: ["packages/**/src/**/*.ts"], fileKinds: ["production"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /\b(?:contractVersion|metricContractVersion|schemaVersion|protocolVersion)\b/.test(text(file))),
    ast: {
      pattern: "[(string) @literal (template_string) @literal]",
      extract: (matches, file) => matches.flatMap((match) => match.captures
        .filter((capture) => capture.name === "literal")
        .map((capture) => ({ _file: file, value: unquote(capture.text), line: capture.startLine }))),
    },
  },
  link: ({ records }) => {
    const byFile = new Map();
    for (const record of records) {
      if (typeof record._file !== "string" || typeof record.value !== "string" || !isVersionIdentity(record.value)) continue;
      const entries = byFile.get(record._file) ?? [];
      entries.push(record);
      byFile.set(record._file, entries);
    }
    return [...byFile.entries()].flatMap(([file, entries]) => {
      const values = new Set(records.filter((record) => record._file === file && typeof record.value === "string").map((record) => record.value));
      if (isClassifiedPersistedBoundary(values)) return [];
      return entries.map((record) => ({
        ruleId: "version-boundary-audit",
        file,
        message: `${record.value} is a version-bearing model without a persisted/protocol or experimental boundary classification`,
        evidence: typeof record.line === "number" ? `L${record.line}` : undefined,
      }));
    });
  },
};
