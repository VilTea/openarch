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
    // 校准 2026-08-07：豁免"箭头函数 + 无 await + return 数字"的 handler 形态——
    // CommandHandler/action 约定（const x: CommandHandler = async (...) => { return 0; }）
    // 要求返回 Promise<number>（exit 码），async 是唯一自然写法，无 await 是常态
    // 而非腐化；function 声明形态的 async 无 await 仍报告。
    return records.flatMap((record) => record.fn && /^\s*async\b/.test(record.fn) && !/\bawait\b/.test(record.fn) && !(record.fn.includes("=>") && /\breturn\s+\d+;/.test(record.fn)) ? [{
      ruleId: "async-without-await", file: record._file, message: "async function has no await expression", evidence: record.fn.slice(0, 160),
    }] : []);
  },
};
