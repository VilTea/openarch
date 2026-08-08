const REPORT_FIELD_BUDGET = 7;

/**
 * A report with many direct properties usually needs named sections or a
 * dedicated evidence bundle. This is an audit signal, never a generic limit.
 */
export default {
  scope: "repository",
  targets: { include: ["packages/**/src/**/*.ts"], fileKinds: ["production"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /(?:export\s+)?interface\s+\w*Report\b/.test(text(file))),
    ast: {
      pattern: "(interface_declaration name: (type_identifier) @name body: (interface_body (property_signature) @property))",
      extract: (matches, file) => matches.flatMap((match) => {
        const name = match.captures.find((capture) => capture.name === "name");
        const property = match.captures.find((capture) => capture.name === "property");
        return name && property && name.text.endsWith("Report") ? [{ _file: file, name: name.text, line: name.startLine }] : [];
      }),
    },
  },
  link: ({ records }) => {
    const reports = new Map();
    for (const record of records) {
      if (typeof record._file !== "string" || typeof record.name !== "string") continue;
      const key = `${record._file}\0${record.name}`;
      const current = reports.get(key) ?? { file: record._file, name: record.name, line: record.line, fieldCount: 0 };
      reports.set(key, { ...current, fieldCount: current.fieldCount + 1 });
    }
    return [...reports.values()]
      .filter((report) => report.fieldCount > REPORT_FIELD_BUDGET)
      .map((report) => ({
        ruleId: "report-surface-audit",
        file: report.file,
        message: `${report.name} has ${report.fieldCount} direct fields (audit budget ${REPORT_FIELD_BUDGET}); investigate named report sections or a dedicated evidence bundle`,
        evidence: typeof report.line === "number" ? `L${report.line}` : undefined,
      }));
  },
};
