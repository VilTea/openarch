import type { SymbolUseRequest } from "../../port/SymbolUseService";
import { existsSync, readFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import type { SymbolUseProvider, SymbolUseProviderContext } from "../../symbol-use/provider";
import { collectLspSymbolUse, type LspSymbolUseDefinition, type LspSymbolUseRuntime } from "./LspSymbolUse";

const rustDefinition = {
  language: "rust",
  providerId: "rust-analyzer-symbol-use",
  languageId: "rust",
  declarationQueries: [{ kind: "function", pattern: "(function_item name: (identifier) @name)" }],
  /** `pub(crate)`, `pub(super)` and `pub(in ...)` stay inside the analyzed crate. */
  isInternal: (_name, source, startIndex) => !/\bpub\s+/.test(source.slice(Math.max(0, source.lastIndexOf("\n", startIndex) + 1), startIndex)),
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
    detected: (source) => /#\s*\[\s*cfg(?:_|\s|\()/.test(source),
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
