import type { SymbolUseRequest } from "../../port/SymbolUseService";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { SymbolUseProvider, SymbolUseProviderContext } from "../../symbol-use/provider";
import { collectLspSymbolUse, commentLinesOf, type LspSymbolUseDefinition, type LspSymbolUseRuntime } from "./LspSymbolUse";

// Go 的 build 约束与 generated 标记按语言约定就是**注释行**，判据取自注释语法节点
// （`(comment)`），而不是"整份文件上的行锚定正则"：整份文件也会扫到原始字符串里的
// `"//go:build windows"`，而注释节点不会。
// `#match?` 只做子串匹配（无 `^` 锚定），所以"必须在该注释首行开头"的精确判据在
// TypeScript 侧完成——避免 `// Code generated ...` 这类模式被其他注释子串误命中。
const GO_COMMENT_QUERY = "(comment) @comment";

const goDefinition = {
  language: "go",
  providerId: "go-gopls-symbol-use",
  languageId: "go",
  declarationQueries: [
    { kind: "function", pattern: "(function_declaration name: (identifier) @name)" },
    { kind: "function", pattern: "(method_declaration name: (field_identifier) @name)" },
  ],
  isInternal: ({ name }) => !/^[A-Z]/.test(name),
  // gopls -remote=auto：客户端代理模式，gopls 自己管理常驻 daemon（索引跨 CLI 调用
  // 复用，空闲自动回收）。shutdown: "self" —— 关闭时只杀客户端，保留 daemon 子进程。
  // OPENARCH_GOPLS_DAEMON=off 时直连单次 serve（集成测试用，避免 daemon 锁临时工作区）。
  launch: (executable) => process.env.OPENARCH_GOPLS_DAEMON === "off"
    ? { command: executable, args: ["serve"] }
    : { command: executable, args: ["-remote=auto"], shutdown: "self" },
  requiresDiagnosticReadiness: true,
  sourceRisks: [
    {
      reason: "Go build constraints make repository references configuration-dependent",
      pattern: GO_COMMENT_QUERY,
      syntax: (matches) => matches.some((match) => commentLinesOf(match).some((line) => /^\/\/(?:go:build|\s*\+build)\b/.test(line))),
    },
    {
      reason: "generated Go source is outside the calibrated symbol-use scope",
      pattern: GO_COMMENT_QUERY,
      syntax: (matches) => matches.some((match) => commentLinesOf(match).some((line) => /^\/\/ Code generated .* DO NOT EDIT\.$/.test(line))),
    },
  ],
  workspaceScope: {
    repositoryReferenceRisks: ({ cwd }) => [
      ...(!existsSync(join(cwd, "go.mod")) ? ["Go symbol-use requires a module rooted at the governed project"] : []),
      ...(existsSync(join(cwd, "go.work")) ? ["Go workspace mode is outside the calibrated single-module symbol-use scope"] : []),
    ],
  },
} satisfies LspSymbolUseDefinition;

export type GoSymbolUseRuntime = LspSymbolUseRuntime;

export const collectGoSymbolUse = (input: SymbolUseRequest, runtime: GoSymbolUseRuntime) =>
  collectLspSymbolUse(input, runtime, goDefinition);

export const goSymbolUseProvider: SymbolUseProvider = {
  id: goDefinition.providerId,
  evidenceSource: "lsp",
  languages: ["go"],
  requiredToolchains: ["gopls", "go"],
  collect: (input, context: SymbolUseProviderContext) => {
    const gopls = context.toolchains.get("gopls");
    const go = context.toolchains.get("go");
    // 配置化 env 优先（toolchains.yml 的 tools.gopls.env / tools.go.env）；缺省回退
    // 到硬编码 PATH 注入（go 可执行文件所在目录），保证 gopls 能找到 go 建立 workspace view。
    const configuredEnv = gopls?.env ?? go?.env;
    const environment = go?.executable
      ? { ...process.env, ...configuredEnv, PATH: [dirname(go.executable), process.env.PATH].filter(Boolean).join(delimiter) }
      : configuredEnv
        ? { ...process.env, ...configuredEnv }
        : undefined;
    return collectGoSymbolUse(input, {
      parser: context.parser,
      executable: gopls?.executable,
      environment,
    });
  },
};
