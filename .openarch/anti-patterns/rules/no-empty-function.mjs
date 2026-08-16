export default {
  scope: "file",
  targets: { languages: ["typescript", "javascript", "vue"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => text(file).includes("function") || /\)\s*\{\s*\}/.test(text(file))),
    ast: {
      pattern: "[(function_declaration name: (_) @name body: (statement_block) @body) (method_definition name: (_) @name body: (statement_block) @body)]",
      extract: (matches) => matches.flatMap((match) => {
        const name = match.captures.find((capture) => capture.name === "name")?.text;
        const body = match.captures.find((capture) => capture.name === "body")?.text;
        return body && name && name !== "constructor" ? [{ name, body }] : [];
      }),
    },
  },
  link({ records }) {
    return records.flatMap((record) => record.body?.replace(/\s/g, "") === "{}" ? [{
      ruleId: "no-empty-function", file: record._file, message: "empty function body may be an unfinished implementation", evidence: record.body,
    }] : []);
  },
};
