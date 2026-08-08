export default {
  scope: "repository",
  requires: ["authorities.v1"],
  targets: { authority: "any" },
  stages: {
    // Authority declarations bound both the files and import literals.  This keeps
    // repository calibration proportional to the project-selected boundary while
    // supporting package and relative imports, not only Node built-ins.
    text: ({ files, text, facts }) => files.filter((file) =>
      (facts.authorities.value ?? []).some((authority) =>
        (authority.prohibitedImports ?? []).some((source) => text(file).includes(source))),
    ),
    ast: { fact: "static-imports.v1" },
  },
  link({ records, facts }) {
    const hits = [];
    for (const record of records) {
      const file = typeof record._file === "string" ? record._file : undefined;
      if (!file || typeof record.source !== "string") continue;
      for (const authority of facts.authorities.value ?? []) {
        const prohibitedImports = new Set(authority.prohibitedImports ?? []);
        if (!prohibitedImports.has(record.source) || !(authority.protectedFiles ?? []).includes(file)) continue;
        hits.push({
          ruleId: "authority-import-bypass",
          file,
          message: `direct import ${record.source} bypasses declared authority ${authority.id}; use ${authority.publicEntry ?? authority.owner}`,
          evidence: `authority=${authority.id}; staticImport=${record.source}`,
        });
      }
    }
    return hits;
  },
};
