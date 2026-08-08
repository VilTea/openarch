const isParserStrategy = (file) => /(^|[\\/])packages[\\/]core[\\/]src[\\/]adapter[\\/]parser[\\/][A-Za-z]+Strategy\.ts$/.test(file);

const capture = (match, name) => match.captures.find((item) => item.name === name);

/**
 * OpenArch project rule: strategies may inspect grammar nodes, but must not
 * turn node.text back into an untyped mini-parser for structural facts.
 */
export default {
  scope: "repository",
  stages: {
    text: ({ files }) => files.filter(isParserStrategy),
    ast: {
      pattern: "[(call_expression) @node (variable_declarator) @node]",
      extract: (matches, file) => matches.flatMap((match) => {
        const node = capture(match, "node");
        if (!node) return [];
        const source = node.text;
        const parsesAstText = /\.text\b/.test(source) && /\.(?:exec|match|matchAll)\s*\(/.test(source);
        const aliasesAstText = /\b(?:const|let)\s+text\s*=\s*[^;]*\.text\b/.test(source);
        return parsesAstText || aliasesAstText ? [{
          file,
          line: node.startLine,
          evidence: source.replace(/\s+/g, " ").slice(0, 180),
        }] : [];
      }),
    },
  },
  link: ({ records }) => records.flatMap((record) =>
    typeof record.file === "string" && typeof record.evidence === "string" ? [{
      ruleId: "no-regex-parser-source",
      file: record.file,
      message: "parser strategy re-parses AST source text; extract the fact from grammar nodes or a shared AST semantic adapter",
      evidence: `${record.evidence}${typeof record.line === "number" ? ` @L${record.line}` : ""}`,
    }] : []),
};
