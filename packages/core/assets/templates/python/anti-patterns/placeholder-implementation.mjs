export default {
  scope: "file",
  targets: { languages: ["python"], include: ["*.py", "**/*.py"], fileKinds: ["production"] },
  stages: {
    text: ({ files, text }) => files.filter((file) => /\bdef\s+\w+/.test(text(file))),
    ast: {
      pattern: `
        (decorated_definition
          (decorator) @decorator
          (function_definition body: (block) @body))
        (class_definition
          superclasses: (argument_list (identifier) @base)
          body: (block (function_definition body: (block) @body)))
        (class_definition
          superclasses: (argument_list (attribute attribute: (identifier) @base))
          body: (block (function_definition body: (block) @body)))
        (function_definition body: (block) @body)
      `,
      extract: (matches) => {
        const bodies = new Map();
        for (const match of matches) {
          const body = match.captures.find((capture) => capture.name === "body");
          if (!body) continue;
          const key = body.startIndex ?? `${body.startLine}:${body.endLine}`;
          const existing = bodies.get(key) ?? {
            body: body.text.trim(), line: body.startLine, endLine: body.endLine, decorators: [], bases: [],
          };
          existing.decorators.push(...match.captures.filter((capture) => capture.name === "decorator").map((capture) => capture.text));
          existing.bases.push(...match.captures.filter((capture) => capture.name === "base").map((capture) => capture.text));
          bodies.set(key, existing);
        }
        return [...bodies.values()];
      },
    },
  },
  link({ records }) {
    return records.flatMap((record) => {
      const isAbstractMethod = Array.isArray(record.decorators)
        && record.decorators.some((decorator) => ["@abstractmethod", "@abc.abstractmethod"].includes(String(decorator).replace(/\s/g, "")));
      const isProtocolMethod = Array.isArray(record.bases) && record.bases.includes("Protocol");
      return !isAbstractMethod && !isProtocolMethod && /^(pass|\.\.\.|raise NotImplementedError(?:\([^)]*\))?)$/.test(String(record.body ?? "")) ? [{
      ruleId: "placeholder-implementation", file: record._file,
      message: "callable body is only a Python placeholder; confirm the implementation is intentionally deferred",
      category: "quality",
      severity: "warning",
      patternFamily: "placeholder-implementation",
      suggestion: "Implement the callable or document why this placeholder is intentionally retained.",
      ...(typeof record.line === "number" ? { line: record.line } : {}),
      ...(typeof record.endLine === "number" ? { endLine: record.endLine } : {}),
      evidence: String(record.body),
      }] : [];
    });
  },
};
