import type { SymbolUseRequest } from "../../port/SymbolUseService";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { SymbolUseProvider, SymbolUseProviderContext } from "../../symbol-use/provider";
import { collectLspSymbolUse, type LspSymbolUseDefinition, type LspSymbolUseRuntime } from "./LspSymbolUse";

const goDefinition = {
  language: "go",
  providerId: "go-gopls-symbol-use",
  languageId: "go",
  declarationQueries: [
    { kind: "function", pattern: "(function_declaration name: (identifier) @name)" },
    { kind: "function", pattern: "(method_declaration name: (field_identifier) @name)" },
  ],
  isInternal: (name) => !/^[A-Z]/.test(name),
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
      detected: (source) => /^\/\/(?:go:build|\s*\+build)\b/m.test(source),
    },
    {
      reason: "generated Go source is outside the calibrated symbol-use scope",
      detected: (source) => /^\/\/ Code generated .* DO NOT EDIT\.$/m.test(source),
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
