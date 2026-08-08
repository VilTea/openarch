export default {
  scope: "file",
  authority: {
    id: "document-capability-location",
    owner: "packages/core/src/document-store/DocumentStore.ts",
    publicEntry: "packages/core/src/document-store/DocumentStore.ts#capabilityAssetPath",
    protectedPaths: [
      "packages/core/src/application/initApp.ts",
      "packages/core/src/docs-repo/DocsRepoManager.ts",
    ],
  },
  targets: { authority: ["document-capability-location"] },
  stages: {
    text: ({ files, text }) => files.filter((file) =>
      text(file).includes("CORE-CAPABILITIES.md")
      && text(file).includes("projects/")),
  },
  link: ({ records, facts }) => {
    const authority = (facts.authorities.value ?? []).find((item) => item.id === "document-capability-location");
    if (!authority) return [];
    return records.map((record) => ({
      ruleId: "no-legacy-document-capability-path",
      file: record._file,
      message: `capability assets must resolve from declared DocumentStore scope; use ${authority.publicEntry ?? authority.owner}`,
      evidence: `authority=${authority.id}; legacy=projects/<cwd-basename>/CORE-CAPABILITIES.md`,
    }));
  },
};
