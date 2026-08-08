export default {
  scope: "file",
  authority: {
    id: "script-starter-assets",
    owner: "packages/openarch-templates/default-scripts.json",
    publicEntry: "packages/openarch-templates/default-scripts.json",
    protectedPaths: ["packages/core/src/script-runtime/scriptStarters.ts"],
  },
  targets: { authority: ["script-starter-assets"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /\bsource\s*:\s*`/.test(text(file))),
  },
  link: ({ records }) => records.map((record) => ({
    ruleId: "no-inline-script-starters",
    file: record._file,
    message: "public script starters must reference a packaged manifest asset instead of embedding script source",
    evidence: "authority=script-starter-assets",
  })),
};
