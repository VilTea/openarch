// OpenArch ESLint flat config (ESLint v10+)
// 三层架构纪律：
//   OpenArch 度量"结构风险与趋势"（CRL_state / I_push）
//   ESLint  守"可静态证明的架构纪律"（类型契约 / 依赖方向）
//   TypeScript 守"类型契约"（编译期检查）
import tsparser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const P95_FIELDS = new Set(["branch", "nesting", "loc", "alpha", "connectedness", "externalPassthrough", "oneMinusConnectedness"]);
const LANGUAGE_IDS = new Set(["typescript", "javascript", "go"]);
const LANGUAGE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".go"]);
const LANGUAGE_INDICATORS = new Set(["go.mod"]);
const isAuthorityFile = (filePath = "") =>
  /(^|[\\/])(?:LanguageRegistry|projectFiles)\.ts$/i.test(filePath);
const normalizeLiteral = (value) =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
const isDirectSourceGlob = (value) =>
  typeof value === "string"
  && (
    /^packages\/(?:\*\*|[^/]+)/.test(value)
    || /^\*\*\/\*\.[a-z]+$/i.test(value)
    || /^src\/\*\*\/\*\.[a-z]+$/i.test(value)
  );

const contractSync = {
  rules: {
    "no-inline-p95-values": {
      meta: { type: "problem", messages: { shadow: "adapter/ 不应内联完整 P95Values，请 import type { P95Values } from 'domain/crlState'" } },
      create(context) {
        return {
          TSTypeLiteral(node) {
            const fields = new Set(node.members.flatMap(member => member.type === "TSPropertySignature" && member.key.type === "Identifier" ? [member.key.name] : []));
            if ([...P95_FIELDS].every(field => fields.has(field))) context.report({ node, messageId: "shadow" });
          },
        };
      },
    },
    "no-cli-p95-field": {
      meta: { type: "problem", messages: { access: "CLI 不应直接访问 P95 字段；改用 core 格式化函数或迭代 Object.entries(r.p95)" } },
      create(context) {
        return {
          MemberExpression(node) {
            if (node.object.type === "MemberExpression" && !node.object.computed && node.object.property.type === "Identifier" && node.object.property.name === "p95" && !node.computed && node.property.type === "Identifier" && P95_FIELDS.has(node.property.name)) context.report({ node, messageId: "access" });
          },
        };
      },
    },
    "no-inline-language-facts": {
      meta: { type: "problem", messages: { shadow: "不要在 authority owner 外并行维护语言 id / 扩展名 / 指示物；改用 LanguageRegistry 导出的入口" } },
      create(context) {
        const literals = [];
        const filename = context.filename ?? "";
        return {
          Literal(node) {
            const value = normalizeLiteral(node.value);
            if (typeof value === "string") literals.push({ node, value });
          },
          "Program:exit"() {
            if (isAuthorityFile(filename)) return;
            const ids = new Set();
            const extensions = new Set();
            const indicators = new Set();
            for (const literal of literals) {
              if (LANGUAGE_IDS.has(literal.value)) ids.add(literal.value);
              if (LANGUAGE_EXTENSIONS.has(literal.value)) extensions.add(literal.value);
              if (LANGUAGE_INDICATORS.has(literal.value)) indicators.add(literal.value);
            }
            const hasParallelFacts = extensions.size >= 2 && (ids.size >= 2 || indicators.size >= 1);
            if (!hasParallelFacts) return;
            const culprit = literals.find((literal) =>
              LANGUAGE_IDS.has(literal.value) || LANGUAGE_EXTENSIONS.has(literal.value) || LANGUAGE_INDICATORS.has(literal.value));
            if (culprit) context.report({ node: culprit.node, messageId: "shadow" });
          },
        };
      },
    },
    "no-direct-source-glob": {
      meta: { type: "problem", messages: { glob: "不要在通用层直接硬编码源码发现 glob；改用 projectFiles.ts / listProjectSourceFiles" } },
      create(context) {
        const filename = context.filename ?? "";
        return {
          CallExpression(node) {
            if (isAuthorityFile(filename)) return;
            const callee = node.callee.type === "Identifier"
              ? node.callee.name
              : node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.type === "Identifier"
                ? node.callee.property.name
                : undefined;
            if (callee !== "globSync") return;
            const [firstArg] = node.arguments;
            if (!firstArg || firstArg.type !== "Literal" || typeof firstArg.value !== "string") return;
            if (isDirectSourceGlob(firstArg.value)) context.report({ node: firstArg, messageId: "glob" });
          },
        };
      },
    },
  },
};

// ── 关键契约所有权（canonical contracts）──
// P95Values   → domain/crlState.ts    — 消费者须 import type { P95Values }，禁止重写同构类型
// IndexEntry  → port/StorageService.ts — 同上
// BaselineIndex → port/StorageService.ts — 同上

export default [
  { ignores: ["**/dist/**", "**/*.d.ts", "node_modules/**", "coverage/**", "**/fixtures/**"] },

  { files: ["packages/**/*.ts"], languageOptions: { parser: tsparser } },

  // ── Domain ──
  {
    files: ["packages/core/src/domain/**/*.ts"],
    languageOptions: { parser: tsparser },
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["effect"], message: "domain/ must not import effect runtime.", allowTypeImports: true },
        { group: ["**/adapter/**"], message: "domain/ must not import adapter.", allowTypeImports: true },
        { group: ["**/port/**"], message: "domain/ must not import port.", allowTypeImports: true },
        { group: ["**/application/**"], message: "domain/ must not import application.", allowTypeImports: true },
      ]}],
    },
  },

  // ── Adapter ──
  {
    files: ["packages/core/src/adapter/**/*.ts"],
    languageOptions: { parser: tsparser },
    plugins: { openarch: contractSync },
    rules: {
      "no-restricted-imports": ["error", { patterns: [
        { group: ["**/application/**"], message: "adapter/ must not import application.", allowTypeImports: true },
      ]}],
      // 禁止 adapter 内联重写完整 P95Values；允许有明确用途的局部投影。
      "openarch/no-inline-p95-values": "warn",
    },
  },

  {
    files: ["packages/core/src/**/*.ts", "packages/cli/src/**/*.ts"],
    ignores: ["packages/core/src/languageSupport.ts", "packages/core/src/projectFiles.ts"],
    languageOptions: { parser: tsparser },
    plugins: { openarch: contractSync, "@typescript-eslint": tsPlugin },
    rules: {
      "openarch/no-inline-language-facts": "warn",
      "openarch/no-direct-source-glob": "warn",
      "@typescript-eslint/no-require-imports": "error",
    },
  },

  // ── CLI（bin 不能裸访问核心契约字段）──
  {
    files: ["packages/cli/bin/**/*.js"],
    plugins: { openarch: contractSync },
    rules: {
      // 禁止 CLI 直接访问 .p95.xxx——须通过 core 导出的格式化函数
      "openarch/no-cli-p95-field": "error",
    },
  },
];
