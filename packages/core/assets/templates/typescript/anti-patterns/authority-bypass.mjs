const normalizeLiteral = (text) => text.replace(/^['"`]|['"`]$/g, "");

const LANGUAGE_IDS = new Set(["typescript", "javascript", "go"]);
const LANGUAGE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".go"]);
const LANGUAGE_INDICATORS = new Set(["go.mod"]);

const hasAuthorityImport = (literal) =>
  typeof literal === "string" && (literal.includes("LanguageRegistry") || literal.includes("projectFiles"));

const isSourceGlob = (literal) =>
  typeof literal === "string"
  && (
    /^packages\/(?:\*\*|[^/]+)/.test(literal)
    || /^\*\*\/\*\.[a-z]+$/i.test(literal)
    || /^src\/\*\*\/\*\.[a-z]+$/i.test(literal)
  );

const isAuthorityOwnerFile = (file) => /(^|[\\/])(?:LanguageRegistry|projectFiles)\.ts$/i.test(file);

export default {
  scope: "repository",
  stages: {
    text: ({ files, text }) => files.filter((file) => {
      const source = text(file);
      return source.includes("LanguageRegistry") || source.includes("projectFiles") || source.includes("packages/") || source.includes("typescript") || source.includes("javascript") || source.includes("go.mod") || source.includes(".tsx") || source.includes(".jsx");
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
      if (typeof record.literal !== "string" || !file || isAuthorityOwnerFile(file)) continue;
      const bucket = grouped.get(file) ?? { hasAuthorityImport: false, hasSourceGlob: false, ids: new Set(), extensions: new Set(), indicators: new Set(), evidence: [] };
      if (hasAuthorityImport(record.literal)) bucket.hasAuthorityImport = true;
      if (isSourceGlob(record.literal)) {
        bucket.hasSourceGlob = true;
        bucket.evidence.push(`${record.literal}${typeof record.line === "number" ? `@L${record.line}` : ""}`);
      }
      if (LANGUAGE_IDS.has(record.literal)) bucket.ids.add(record.literal);
      if (LANGUAGE_EXTENSIONS.has(record.literal)) bucket.extensions.add(record.literal);
      if (LANGUAGE_INDICATORS.has(record.literal)) bucket.indicators.add(record.literal);
      if (LANGUAGE_IDS.has(record.literal) || LANGUAGE_EXTENSIONS.has(record.literal) || LANGUAGE_INDICATORS.has(record.literal)) {
        bucket.evidence.push(`${record.literal}${typeof record.line === "number" ? `@L${record.line}` : ""}`);
      }
      grouped.set(file, bucket);
    }

    const hits = [];
    for (const [file, bucket] of grouped.entries()) {
      const hasLanguageFacts = bucket.extensions.size >= 2 && (bucket.ids.size >= 2 || bucket.indicators.size >= 1);
      if (bucket.hasAuthorityImport || (!bucket.hasSourceGlob && !hasLanguageFacts)) continue;
      hits.push({
        ruleId: "authority-bypass",
        file,
        message: "file appears to implement language/source discovery without importing registered authority entrypoints",
        evidence: bucket.evidence.slice(0, 6).join(", "),
      });
    }
    return hits;
  },
};
