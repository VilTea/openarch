export default {
  scope: "file",
  stages: {
    text: ({ files, text }) => files.filter((file) => text(file).includes("async")),
    ast: {
      pattern: "[(function_declaration) @function (method_definition) @function (arrow_function) @function]",
      extract: (matches) => matches.flatMap((match) => {
        const fn = match.captures.find((capture) => capture.name === "function")?.text;
        return fn ? [{ fn }] : [];
      }),
    },
  },
  link({ records }) {
    return records.flatMap((record) => record.fn && /^\s*async\b/.test(record.fn) && !/\bawait\b/.test(record.fn) ? [{
      ruleId: "async-without-await", file: record._file, message: "async function has no await expression", evidence: record.fn.slice(0, 160),
    }] : []);
  },
};
