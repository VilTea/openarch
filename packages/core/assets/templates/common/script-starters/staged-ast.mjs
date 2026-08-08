export default {
  // Add scope: "file" | "repository" when this is an anti-pattern rule.
  stages: {
    text: ({ files, text }) => files.filter((file) => text(file).includes("candidate")),
    ast: { pattern: "(identifier) @name" },
  },
  link: ({ records }) => {
    // Return the output contract of the selected engine.
    return [];
  },
};
