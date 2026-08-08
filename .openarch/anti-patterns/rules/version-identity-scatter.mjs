const versionIdentity = (text) => text.replace(/^['"`]|['"`]$/g, "");
const isVersionIdentity = (value) => /^[a-z][a-z0-9-]*-v[1-9][0-9]*$/.test(value);

/**
 * Project-local guard: a semantic version identity is defined once by its
 * owning module and imported by consumers. It does not judge schema "1"
 * values, which are a separate persistence concern.
 */
export default {
  scope: "repository",
  targets: { include: ["packages/**/src/**/*.ts"], fileKinds: ["production"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /['"`][a-z][a-z0-9-]*-v[1-9][0-9]*['"`]/.test(text(file))),
    ast: {
      pattern: "[(string) @literal (template_string) @literal]",
      extract: (matches, file) => matches.flatMap((match) => match.captures
        .filter((capture) => capture.name === "literal")
        .map((capture) => ({ _file: file, value: versionIdentity(capture.text), line: capture.startLine }))),
    },
  },
  link: ({ records }) => {
    const locations = new Map();
    for (const record of records) {
      if (typeof record._file !== "string" || typeof record.value !== "string" || !isVersionIdentity(record.value)) continue;
      const files = locations.get(record.value) ?? new Map();
      const lines = files.get(record._file) ?? [];
      if (typeof record.line === "number") lines.push(record.line);
      files.set(record._file, lines);
      locations.set(record.value, files);
    }
    return [...locations.entries()].flatMap(([identity, files]) => files.size <= 1 ? [] : [{
      ruleId: "version-identity-scatter",
      file: [...files.keys()].sort()[0],
      message: `version identity ${identity} is written in ${files.size} production modules; define it once in its owning boundary and import it elsewhere`,
      evidence: [...files.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([file, lines]) => `${file}${lines.length ? `:L${[...new Set(lines)].join(",L")}` : ""}`).join("; "),
    }]);
  },
};
