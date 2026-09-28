import type { SymbolUseRequest } from "../../port/SymbolUseService";
import { existsSync, readFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { SymbolUseProvider, SymbolUseProviderContext } from "../../symbol-use/provider";
import { collectLspSymbolUse, type LspSymbolUseDefinition, type LspSymbolUseRuntime } from "./LspSymbolUse";

// `#[cfg]` 的权威判据是**属性语法节点**：注释里的 `// #[cfg(test)] kept for reference`
// 不产生 `attribute_item`，因此不再伪造"超出校准范围"的证据（D6）。同一判据也在
// `RustSemanticRelationProvider` 使用（同一概念一个权威入口）。
export const RUST_CFG_RISK_QUERY = `(attribute_item (attribute (identifier) @name) (#eq? @name "cfg"))`;

/**
 * Rust 可见性语法事实（模块私有；对外只经 `rustDefinition.isInternal` 暴露，
 * 规则本身只服务这一个判定点，不额外增加公开面）：
 * - 无 `visibility_modifier` = 私有（crate 内）→ internal；
 * - `pub(crate)` / `pub(super)` / `pub(self)` / `pub(in ...)` = 限定在 crate 内 → internal；
 * - `pub` 才是对外可见面（`declared-public`）。
 */
const isInternalRustVisibility = (modifiers: string): boolean => {
  const visibility = modifiers.replace(/\s+/g, "");
  return visibility === "" || visibility.startsWith("pub(") ? true : visibility !== "pub";
};

export const rustDefinition = {
  language: "rust",
  providerId: "rust-analyzer-symbol-use",
  languageId: "rust",
  // 修饰符由语法节点给出：`pub\nfn foo()` 的 `pub` 在同一 `function_item` 的
  // `(visibility_modifier)` 里（D11 的 Rust 面）。
  declarationQueries: [{ kind: "function", pattern: "(function_item (visibility_modifier)? @modifiers name: (identifier) @name)" }],
  isInternal: ({ modifiers }) => isInternalRustVisibility(modifiers),
  launch: (executable) => ({ command: executable, args: [] }),
  requiresDiagnosticReadiness: true,
  // diagnostics 早于 find-references 完整索引（校准 2026-08-06）；用 workspace/symbol
  // 轮询候选声明作为索引就绪信号，让同 crate 跨文件引用可被确认。
  indexReady: {},
  coverageRisks: [{
    pattern: "(macro_invocation) @macro",
    reason: "Rust macro expansion is outside the calibrated symbol-use scope",
    detected: (matches) => matches.length > 0,
  }, {
    pattern: "(attribute_item (attribute (identifier) @name))",
    reason: "Rust derive or proc-macro expansion is outside the calibrated symbol-use scope",
    detected: (matches) => matches.some((match) => match.captures.some((capture) =>
      capture.name === "name" && ["derive", "proc_macro", "proc_macro_attribute", "proc_macro_derive"].includes(capture.text))),
  }, {
    pattern: "(attribute_item (attribute (scoped_identifier) @name))",
    reason: "Rust path attribute macros are outside the calibrated symbol-use scope",
    detected: (matches) => matches.length > 0,
  }],
  sourceRisks: [{
    reason: "Rust conditional compilation is outside the calibrated symbol-use scope",
    pattern: RUST_CFG_RISK_QUERY,
    syntax: (matches) => matches.length > 0,
  }],
  workspaceScope: {
    declarationRisks: ({ files }) => files.some((file) => basename(file) === "build.rs")
      ? ["Rust build scripts are outside the calibrated symbol-use scope"]
      : [],
    repositoryReferenceRisks: ({ cwd }) => {
      const cargoToml = join(cwd, "Cargo.toml");
      const manifest = existsSync(cargoToml) ? readFileSync(cargoToml, "utf8") : "";
      return [
        ...(!manifest ? ["Rust symbol-use requires a Cargo.toml crate rooted at the governed project"] : []),
        ...(/^\s*\[workspace\]/m.test(manifest) ? ["Cargo workspace manifests are outside the calibrated single-crate symbol-use scope"] : []),
      ];
    },
  },
} satisfies LspSymbolUseDefinition;

export type RustSymbolUseRuntime = LspSymbolUseRuntime;

export const collectRustSymbolUse = (input: SymbolUseRequest, runtime: RustSymbolUseRuntime) =>
  collectLspSymbolUse(input, runtime, rustDefinition);

export const rustSymbolUseProvider: SymbolUseProvider = {
  id: rustDefinition.providerId,
  evidenceSource: "lsp",
  languages: ["rust"],
  requiredToolchains: ["rust-analyzer", "cargo"],
  collect: (input, context: SymbolUseProviderContext) => {
    const ra = context.toolchains.get("rust-analyzer");
    const cargo = context.toolchains.get("cargo");
    // 配置化 env 优先（toolchains.yml 的 tools.rust-analyzer.env）；缺省回退到
    // cargo 可执行文件所在目录的 PATH 注入，保证 rust-analyzer 能找到 cargo。
    const configuredEnv = ra?.env ?? cargo?.env;
    const environment = cargo?.executable
      ? { ...process.env, ...configuredEnv, PATH: [dirname(cargo.executable), process.env.PATH].filter(Boolean).join(delimiter) }
      : configuredEnv
        ? { ...process.env, ...configuredEnv }
        : undefined;
    return collectRustSymbolUse(input, {
      parser: context.parser,
      executable: ra?.executable,
      environment,
    });
  },
};
