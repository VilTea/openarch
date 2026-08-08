// 符号级请求策略（能力声明驱动，校准 2026-08-08）：
// 请求 symbol-use 的条件由 provider 的能力声明决定——compiler-based provider
// （evidenceSource !== "lsp"，如 typescript-symbol-use）无需 LSP 门控；--semantic
// 显式开启 LSP 语义（go/rust/java 的 LSP provider）。调用方不得硬编码语言列表。
import type { SemanticFileProfile } from "../../application/semanticDiff";
import { findLanguageForFile } from "../parser/LanguageRegistry";
import { PROVIDERS } from "./SymbolUseServiceLive";

/** 能力声明：不需要 LSP 的 provider 覆盖的语言（compiler/runtime-based）。 */
export const nonLspProviderLanguages = (): readonly string[] =>
  PROVIDERS.filter((provider) => provider.evidenceSource !== "lsp").flatMap((provider) => provider.languages);

/**
 * 变更文件是否需要符号级请求：
 * - `--semantic`（LSP 语义）显式开启 → 总是请求；
 * - 否则仅当变更文件中任一语言被非 LSP provider 覆盖（能力声明驱动）。
 */
export const symbolUseRequestPolicy = (profiles: readonly SemanticFileProfile[], opts: { readonly semantic: boolean }): boolean =>
  opts.semantic
  || profiles.some((profile) => nonLspProviderLanguages().includes(findLanguageForFile(profile.file)?.id ?? "unknown"));
