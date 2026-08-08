// packages/core/src/script-runtime/implicitDependencyAdapters.ts
// 变更时隐式依赖分析的语言适配器（2026-08-07）：为多语言分析做好入口——
// 每种语言提供容器查询（变更行所在的方法/函数/类）与动态引用模式
// （动态 import/require/反射调用——LSP 与通用静态分析无法捕捉的隐式依赖
// 信号）。脚本引擎不接 LSP：这些模式是脚本分析变更片段的语言侧参考。

/** 变更片段分析的语言能力（按语言分发——脚本引擎的入口）。 */
export interface ImplicitDependencyLanguageAdapter {
  /**
   * tree-sitter 容器查询：变更行所在的方法/函数/类声明。
   * 约定：容器节点用 @class/@method/@function 捕获（kind 即捕获名），
   * 名字用 @name 捕获；匹配行范围（startLine/endLine）做最小包含归属。
   * 未提供时 hunk.container 为空（脚本自行降级）。
   */
  readonly containerQuery?: string;
  /**
   * 动态引用模式（变更片段中的隐式依赖信号——供脚本/示例规则参考；
   * 引擎不代跑，脚本在 link 阶段对 hunk.after 自行匹配）。
   */
  readonly dynamicReferencePatterns?: readonly string[];
}

/** 各语言的容器查询模式（tree-sitter 节点名对齐现有声明查询——
 * Java/Python/Go/Rust 参考各 SymbolUseProvider 的 declarationQueries）。 */
const TS_CONTAINER_QUERY = `
  (class_declaration name: (type_identifier) @name) @class
  (method_definition name: (property_identifier) @name) @method
  (function_declaration name: (identifier) @name) @function
`;

const JS_CONTAINER_QUERY = `
  (class_declaration name: (identifier) @name) @class
  (method_definition name: (property_identifier) @name) @method
  (function_declaration name: (identifier) @name) @function
`;

const JAVA_CONTAINER_QUERY = `
  (class_declaration name: (identifier) @name) @class
  (method_declaration name: (identifier) @name) @method
`;

const PYTHON_CONTAINER_QUERY = `
  (class_definition name: (identifier) @name) @class
  (function_definition name: (identifier) @name) @function
`;

const GO_CONTAINER_QUERY = `
  (type_declaration (type_spec name: (type_identifier) @name)) @class
  (method_declaration name: (field_identifier) @name) @method
  (function_declaration name: (identifier) @name) @function
`;

const RUST_CONTAINER_QUERY = `
  (struct_item name: (type_identifier) @name) @class
  (impl_item name: (type_identifier) @name) @class
  (function_item name: (identifier) @name) @function
`;

export const IMPLICIT_DEPENDENCY_ADAPTERS: Readonly<Record<string, ImplicitDependencyLanguageAdapter>> = {
  "typescript": {
    containerQuery: TS_CONTAINER_QUERY,
    dynamicReferencePatterns: ["import\\s*\\(\\s*[`'\"\\w$]", "require\\s*\\(\\s*[`'\"]", "require\\s*\\(\\s*[A-Za-z_$]"],
  },
  "javascript": {
    containerQuery: JS_CONTAINER_QUERY,
    dynamicReferencePatterns: ["import\\s*\\(\\s*[`'\"\\w$]", "require\\s*\\(\\s*[`'\"]"],
  },
  "java": {
    containerQuery: JAVA_CONTAINER_QUERY,
    // Class.forName / getResource / ServiceLoader——反射与 SPI 加载
    dynamicReferencePatterns: ["Class\\.forName\\s*\\(", "getResource(AsStream)?\\s*\\(", "ServiceLoader\\.load"],
  },
  "python": {
    containerQuery: PYTHON_CONTAINER_QUERY,
    // importlib / __import__ / getattr 反射 / entry_points
    dynamicReferencePatterns: ["importlib\\\\.", "__import__\\s*\\(", "getattr\\s*\\(", "entry_points\\s*\\("],
  },
  "go": {
    containerQuery: GO_CONTAINER_QUERY,
    // reflect 包——运行时类型/方法解析
    dynamicReferencePatterns: ["reflect\\.", "plugin\\.Open"],
  },
  "rust": {
    containerQuery: RUST_CONTAINER_QUERY,
    // 无内建反射——宏/动态加载（libloading/ctor）是隐式依赖信号
    dynamicReferencePatterns: ["libloading::", "include_bytes!|include_str!", "ctor::"],
  },
};

/** 语言适配器入口（未知语言返回 undefined——脚本自行降级）。 */
export const implicitDependencyAdapterFor = (language: string): ImplicitDependencyLanguageAdapter | undefined =>
  IMPLICIT_DEPENDENCY_ADAPTERS[language];
