import type { Node } from "web-tree-sitter";
import type { FunctionInfo } from "../../domain/ast";

export type BranchClass = "ordinary" | "guard" | "case";
export type CallTarget =
  | { readonly kind: "direct"; readonly name: string }
  | { readonly kind: "member"; readonly name: string };

/** Grammar-specific semantics needed by the shared structural traversal. */
export interface LanguageStructuralSemantics {
  readonly functionTypes: ReadonlySet<string>;
  readonly blockTypes: ReadonlySet<string>;
  readonly callNodeTypes: ReadonlySet<string>;
  /** 类型/接口/结构体/枚举声明节点：只计头行（体内成员归实现，跨语言统一口径，校准 2026-08-08）。 */
  readonly declarationNodeTypes: ReadonlySet<string>;
  /** 纯声明块节点（interface/type/struct/enum 等无体声明）：整个块体算声明（成员行是声明不是实现，校准 2026-08-08）。 */
  readonly declarationBlockTypes: ReadonlySet<string>;
  readonly classifyBranch: (node: Node) => BranchClass | undefined;
  readonly functionName: (node: Node) => string;
  /**
   * Direct callees can be compared with same-file declarations. Member and
   * dynamic dispatch lack enough local evidence to be called external.
   */
  readonly callTarget: (node: Node) => CallTarget | null;
}

export interface StructuralFacts {
  readonly weightedBranchTotal: number;
  readonly topLevelWeightedBranch: number;
  readonly nestingDepth: number;
  readonly functionCount: number;
  readonly passthroughCalls: number;
  readonly maxFuncBranch: number;
  readonly externalPassthroughCalls: number;
  readonly functions: readonly FunctionInfo[];
  readonly commentLines: ReadonlySet<number>;
  /** 声明行（类型/接口/结构体/枚举头 + 函数签名行）：loc 因子按实现行口径时排除。 */
  readonly declarationLines: ReadonlySet<number>;
}

const branchWeight = (kind: BranchClass | undefined): number => {
  if (kind === "ordinary") return 1.0;
  if (kind === "guard" || kind === "case") return 0.3;
  return 0;
};

export const countNodeTypes = (node: Node, types: ReadonlySet<string>): number => {
  let count = types.has(node.type) ? 1 : 0;
  for (const child of node.children) count += countNodeTypes(child, types);
  return count;
};

const countWeightedBranches = (node: Node, semantics: LanguageStructuralSemantics): number =>
  branchWeight(semantics.classifyBranch(node))
    + node.children.reduce((sum, child) => sum + countWeightedBranches(child, semantics), 0);

const countTopLevelWeightedBranches = (
  node: Node,
  semantics: LanguageStructuralSemantics,
  isRoot = true,
): number => {
  if (!isRoot && semantics.functionTypes.has(node.type)) return 0;
  return branchWeight(semantics.classifyBranch(node))
    + node.children.reduce((sum, child) => sum + countTopLevelWeightedBranches(child, semantics, false), 0);
};

const maxNestingDepth = (node: Node, blockTypes: ReadonlySet<string>, depth = 0): number => {
  const next = blockTypes.has(node.type) ? depth + 1 : depth;
  let max = next;
  for (const child of node.namedChildren) max = Math.max(max, maxNestingDepth(child, blockTypes, next));
  return max;
};

const collectCommentLines = (node: Node, lines: Set<number>): void => {
  if (node.type === "comment") {
    for (let row = node.startPosition.row; row <= node.endPosition.row; row++) lines.add(row);
  }
  for (const child of node.children) collectCommentLines(child, lines);
};

const functionInfo = (node: Node, semantics: LanguageStructuralSemantics): FunctionInfo => {
  const calls: string[] = [];
  const visit = (current: Node, isRoot = false): number => {
    // Nested functions own their own complexity and calls. They are collected by
    // the outer traversal rather than being folded into the containing function.
    if (!isRoot && semantics.functionTypes.has(current.type)) return 0;
    if (semantics.callNodeTypes.has(current.type)) {
      const target = semantics.callTarget(current);
      if (target) calls.push(target.name);
    }
    return branchWeight(semantics.classifyBranch(current))
      + current.children.reduce((sum, child) => sum + visit(child), 0);
  };
  return {
    name: semantics.functionName(node),
    branchCount: visit(node, true),
    calls: [...new Set(calls)],
  };
};

const extractFunctions = (root: Node, semantics: LanguageStructuralSemantics): readonly FunctionInfo[] => {
  const functions: FunctionInfo[] = [];
  const visit = (node: Node): void => {
    if (semantics.functionTypes.has(node.type)) functions.push(functionInfo(node, semantics));
    for (const child of node.children) visit(child);
  };
  visit(root);
  return functions;
};

export const collectStructuralFacts = (root: Node, semantics: LanguageStructuralSemantics): StructuralFacts => {
  const functions = extractFunctions(root, semantics);
  const commentLines = new Set<number>();
  collectCommentLines(root, commentLines);
  // 声明行（校准 2026-08-08）：
  // - declarationBlockTypes（纯声明块：interface/type/struct/enum）→ 整个块体算声明
  // - declarationNodeTypes（含体类型头：class/trait）+ functionTypes → 只计头行（签名）
  const declarationLines = new Set<number>();
  const collectDeclarationLines = (node: Node): void => {
    if (semantics.declarationBlockTypes.has(node.type)) {
      for (let row = node.startPosition.row; row <= node.endPosition.row; row++) {
        if (!commentLines.has(row)) declarationLines.add(row); // 块内注释是注释不是声明
      }
    } else if (semantics.declarationNodeTypes.has(node.type) || semantics.functionTypes.has(node.type)) {
      declarationLines.add(node.startPosition.row);
    }
    for (const child of node.children) collectDeclarationLines(child);
  };
  collectDeclarationLines(root);
  const passthroughCalls = countNodeTypes(root, semantics.callNodeTypes);
  const localFunctionNames = new Set(functions.map((fn) => fn.name).filter((name) => !name.startsWith("(")));
  const countKnownExternalDirectCalls = (node: Node): number => {
    let count = 0;
    if (semantics.callNodeTypes.has(node.type)) {
      const target = semantics.callTarget(node);
      // A direct callee not declared in this file is the only external-call
      // fact available consistently across parsers. Member/dynamic calls are
      // deliberately unknown rather than charged to CRL.
      if (target?.kind === "direct" && !localFunctionNames.has(target.name)) count++;
    }
    for (const child of node.children) count += countKnownExternalDirectCalls(child);
    return count;
  };
  return {
    weightedBranchTotal: countWeightedBranches(root, semantics),
    topLevelWeightedBranch: countTopLevelWeightedBranches(root, semantics),
    nestingDepth: maxNestingDepth(root, semantics.blockTypes),
    functionCount: countNodeTypes(root, semantics.functionTypes),
    passthroughCalls,
    maxFuncBranch: functions.length > 0 ? Math.max(...functions.map((fn) => fn.branchCount)) : 0,
    externalPassthroughCalls: countKnownExternalDirectCalls(root),
    functions,
    commentLines,
    declarationLines,
  };
};
