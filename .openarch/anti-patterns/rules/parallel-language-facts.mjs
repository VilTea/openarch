const normalizeLiteral = (text) => text.replace(/^['"`]|['"`]$/g, "");

const LANGUAGE_IDS = new Set(["typescript", "javascript", "go"]);
const LANGUAGE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".go"]);
const LANGUAGE_INDICATORS = new Set(["go.mod"]);

const isAuthorityFile = (file) => /(^|[\\/])LanguageRegistry\.ts$/i.test(file);

export default {
  scope: "repository",
  // ESLint and release probes deliberately describe their own execution scope;
  // they do not select a parser strategy at runtime.
  targets: { include: ["packages/**/src/**", "packages/cli/bin/**"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => {
      const source = text(file);
      return source.includes("typescript") || source.includes("javascript") || source.includes("go.mod") || source.includes(".tsx") || source.includes(".jsx");
    }),
    ast: {
      pattern: "[(string) @literal (template_string) @literal]",
      extract: (matches, file) =>
      matches.flatMap((match) =>
        match.captures
          .filter((capture) => capture.name === "literal")
          .map((capture) => ({
            literal: normalizeLiteral(capture.text),
            line: capture.startLine,
            file,
          }))),
    },
  },
  link({ records }) {
    const grouped = new Map();

    for (const record of records) {
      const file = typeof record._file === "string" ? record._file : typeof record.file === "string" ? record.file : undefined;
      if (typeof record.literal !== "string" || !file || isAuthorityFile(file)) continue;
      const literal = record.literal;
      const bucket = grouped.get(file) ?? { ids: new Set(), extensions: new Set(), indicators: new Set(), evidence: [] };
      if (LANGUAGE_IDS.has(literal)) bucket.ids.add(literal);
      if (LANGUAGE_EXTENSIONS.has(literal)) bucket.extensions.add(literal);
      if (LANGUAGE_INDICATORS.has(literal)) bucket.indicators.add(literal);
      if (LANGUAGE_IDS.has(literal) || LANGUAGE_EXTENSIONS.has(literal) || LANGUAGE_INDICATORS.has(literal)) {
        bucket.evidence.push(`${literal}${typeof record.line === "number" ? `@L${record.line}` : ""}`);
      }
      grouped.set(file, bucket);
    }

    const hits = [];
    for (const [file, bucket] of grouped.entries()) {
      const hasParallelFacts = bucket.extensions.size >= 2 && (bucket.ids.size >= 2 || bucket.indicators.size >= 1);
      if (!hasParallelFacts) continue;
      hits.push({
        ruleId: "parallel-language-facts",
        file,
        message: "language ids/extensions/indicators appear outside LanguageRegistry.ts; keep parser routing and language metadata in one registration authority",
        evidence: bucket.evidence.slice(0, 6).join(", "),
      });
    }
    return hits;
  },
};
