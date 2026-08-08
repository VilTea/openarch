// Project security rule calibrated from the DocsRepoManager command-injection fix.
// It detects only a narrow syntax fact: a shell-string executor receives a template
// literal with interpolation. It does not claim to model taint or shell escaping.
const SHELL_STRING_EXECUTORS = new Set(["exec", "execSync"]);

export default {
  scope: "file",
  targets: { include: ["packages/**/*.ts", "packages/**/*.js"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{/.test(text(file))),
    ast: {
      pattern: "(call_expression function: (identifier) @callee arguments: (arguments (template_string) @command))",
      extract: (matches) => matches.flatMap((match) => {
        const callee = match.captures.find((capture) => capture.name === "callee")?.text;
        const command = match.captures.find((capture) => capture.name === "command")?.text;
        return callee && command ? [{ callee, command }] : [];
      }),
    },
  },
  link({ records }) {
    return records.flatMap((record) =>
      SHELL_STRING_EXECUTORS.has(record.callee) && /\$\{/.test(record.command)
        ? [{
          ruleId: "no-interpolated-shell-command",
          file: record._file,
          message: "shell-string executor receives an interpolated template; use an argument-vector API or a validated boundary",
          evidence: record.command.slice(0, 160),
        }]
        : []);
  },
};
