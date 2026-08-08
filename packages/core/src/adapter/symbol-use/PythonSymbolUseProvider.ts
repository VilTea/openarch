import type { SymbolUseRequest } from "../../port/SymbolUseService";
import type { SymbolUseProvider, SymbolUseProviderContext } from "../../symbol-use/provider";
import { collectLspSymbolUse, type LspSymbolUseDefinition, type LspSymbolUseRuntime } from "./LspSymbolUse";
import { pyrightWorkspaceRisks } from "./PyrightWorkspaceScope";

export type PythonSymbolUseRuntime = LspSymbolUseRuntime;

const pythonDefinition = {
  language: "python" as const,
  providerId: "python-pyright-symbol-use",
  languageId: "python",
  declarationQueries: [
    { kind: "function" as const, pattern: "(function_definition name: (identifier) @name)" },
    { kind: "class" as const, pattern: "(class_definition name: (identifier) @name)" },
  ],
  // pyright 的 node 入口（langserver.index.js）需要 --stdio；npm shim 的
  // %~dp0 在 Windows cmd /c 批量包装的引号下损坏（退出 1，校准 2026-08-06）。
  // toolchains.yml 可把 pyright 指到原生 node 入口——检测到 .js 用 node 启动。
  launch: (executable) => executable.toLowerCase().endsWith(".js")
    ? { command: process.env.OPENARCH_NODE ?? "node", args: [executable, "--stdio"] }
    : { command: executable, args: [] },
  // Python data-model hooks are invoked by the runtime, so a repository
  // references query cannot establish that a __name__ declaration is unused.
  // Keep name-mangled __private implementations eligible for report-only facts.
  isInternal: (name: string) => name.startsWith("_") && !/^__.*__$/.test(name),
  isCandidate: (name: string) => !/^__.*__$/.test(name),
  workspaceScope: { repositoryReferenceRisks: pyrightWorkspaceRisks },
  // pyright returns an empty references result before its workspace index is
  // ready (measured ~1.2s cold for 78 files, silently empty otherwise) - wait
  // for diagnostics so an empty consumer list is a real fact, not a cold index.
  requiresDiagnosticReadiness: true,
  coverageRisks: [{
    pattern: `[
      (call function: (identifier) @callee)
      (call function: (attribute object: (identifier) @receiver attribute: (identifier) @method))
      (import_statement (dotted_name) @module)
      (import_from_statement module_name: (dotted_name) @module)
    ]`,
    reason: "parser detected dynamic Python import or attribute resolution; repository references are not complete",
    detected: (matches) => matches.some((match) => {
      const captures = new Map(match.captures.map((capture) => [capture.name, capture.text]));
      const callee = captures.get("callee");
      const method = captures.get("method");
      const receiver = captures.get("receiver");
      const module = captures.get("module");
      return callee === "getattr" || callee === "setattr" || callee === "__import__"
        || (receiver === "importlib" && ["import_module", "reload"].includes(method ?? ""))
        || module === "importlib" || module?.startsWith("importlib.") === true;
    }),
  }, {
    pattern: `[
      (decorated_definition (decorator (identifier) @decorator))
      (decorated_definition (decorator (attribute object: (identifier) @receiver attribute: (identifier) @decorator)))
    ]`,
    reason: "parser detected Python abstract-method dispatch; repository direct references are not complete",
    detected: (matches) => matches.some((match) => {
      const captures = new Map(match.captures.map((capture) => [capture.name, capture.text]));
      return captures.get("decorator") === "abstractmethod"
        && (!captures.has("receiver") || captures.get("receiver") === "abc");
    }),
  }, {
    pattern: `[
      (call function: (attribute object: (attribute object: (identifier) @receiver attribute: (identifier) @property) attribute: (identifier) @method))
      (assignment left: (attribute object: (identifier) @receiver attribute: (identifier) @property))
      (augmented_assignment left: (attribute object: (identifier) @receiver attribute: (identifier) @property))
    ]`,
    reason: "parser detected Python runtime import-path mutation; repository references are not complete",
    detected: (matches) => matches.some((match) => {
      const captures = new Map(match.captures.map((capture) => [capture.name, capture.text]));
      return captures.get("receiver") === "sys" && ["path", "meta_path", "path_hooks"].includes(captures.get("property") ?? "");
    }),
  }],
} satisfies LspSymbolUseDefinition;

export const collectPythonSymbolUse = (input: SymbolUseRequest, runtime: PythonSymbolUseRuntime) =>
  collectLspSymbolUse(input, runtime, pythonDefinition);

export const pythonSymbolUseProvider: SymbolUseProvider = {
  id: pythonDefinition.providerId,
  evidenceSource: "lsp",
  languages: ["python"],
  requiredToolchains: ["pyright"],
  collect: (input, context: SymbolUseProviderContext) => collectPythonSymbolUse(input, {
    parser: context.parser,
    executable: context.toolchains.get("pyright")?.executable,
  }),
};
