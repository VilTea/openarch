export default {
  scope: "file",
  stages: {
    text: ({ files, text }) => files.filter((file) => text(file).includes("function") || text(file).includes("=>")),
    ast: {
      pattern: "[(function_declaration body: (statement_block) @body) (arrow_function body: (statement_block) @body)]",
      extract: (matches) => matches.flatMap((match) => {
        const body = match.captures.find((capture) => capture.name === "body")?.text;
        return body ? [{ body }] : [];
      }),
    },
  },
  link({ records }) {
    return records.flatMap((record) => record.body?.replace(/\s/g, "") === "{}" ? [{
      ruleId: "no-empty-function", file: record._file, message: "empty function body may be an unfinished implementation", evidence: record.body,
    }] : []);
  },
};
