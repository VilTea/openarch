/**
 * OpenArch project rule: application workflows must obtain baseline entries
 * through StorageService so adapter validation and storage replacement remain
 * one authority. This deliberately guards only the observed baseline-reader
 * pattern, not all legitimate filesystem work in application workflows.
 */
export default {
  scope: "repository",
  authority: {
    id: "baseline-storage-access",
    owner: "packages/core/src/port/StorageService.ts",
    publicEntry: "packages/core/src/port/StorageService.ts#StorageService",
    protectedPaths: [
      "packages/core/src/application/governance/gateApp.ts",
      "packages/core/src/application/governance/review.ts",
      "packages/core/src/application/record.ts",
    ],
  },
  targets: { authority: ["baseline-storage-access"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => {
      const source = text(file);
      return source.includes("node:fs") && (source.includes("baselineDir") || source.includes("baselineIndex"));
    }),
    ast: {
      pattern: "(import_statement) @import",
      extract: (matches, file) => matches.flatMap((match) =>
        match.captures
          .filter((capture) => capture.name === "import")
          .flatMap((capture) => {
            const statement = capture.text;
            if (statement.includes('from "node:fs"') || statement.includes("from 'node:fs'")) return [{ _file: file, kind: "filesystem" }];
            if ((statement.includes("baselineDir") || statement.includes("baselineIndex")) && statement.includes("infra/paths")) return [{ _file: file, kind: "baseline-path" }];
            return [];
          })),
    },
  },
  link: ({ records, facts }) => {
    const authority = (facts.authorities.value ?? []).find((item) => item.id === "baseline-storage-access");
    if (!authority) return [];
    const importsByFile = new Map();
    for (const record of records) {
      if (typeof record._file !== "string" || typeof record.kind !== "string") continue;
      const kinds = importsByFile.get(record._file) ?? new Set();
      kinds.add(record.kind);
      importsByFile.set(record._file, kinds);
    }
    return [...importsByFile.entries()]
      .filter(([, kinds]) => kinds.has("filesystem") && kinds.has("baseline-path"))
      .map(([file]) => ({
        ruleId: "no-direct-baseline-storage",
        file,
        message: `application baseline reads must use ${authority.publicEntry ?? authority.owner}; do not enumerate or parse baseline shards directly`,
        evidence: `authority=${authority.id}; imports=node:fs+infra/paths baseline helper`,
      }));
  },
};
