export default {
  targets: { fileKinds: ["production"], pathClasses: ["target-layer"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => text(file).includes("candidate")),
    ast: { pattern: "(identifier) @name" },
  },
  link: ({ records }) => [],
};
