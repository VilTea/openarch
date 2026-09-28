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

/**
 * 沿“容器”节点下钻到第一条真实语句。
 *
 * 容器 = 语法上的包裹层（block / statement_block / statement_list /
 * Rust 的 expression_statement）。块内第一条真正要看的节点是它的
 * **第一个具名子节点**：用 `children` 会拿到 `{` 这类匿名 token。
 *
 * 这条约束是本次整改的核心（认知点原则 §3.2 消除平行实现）：
 * 0.1.5 里 TS 与 Java 各写了一份卫语句判据，且互相镜像 ——
 * `TsAstSemantics` 用 `children[0]` 读块，于是带花括号的卫语句被读成 `{`（记普通分支），
 * 只有无花括号形态才算卫语句；`JavaStrategy` 用 `namedChildren[0]`，于是只有带花括号形态才算卫语句。
 * 两边的“正确形态”恰好是对方的漏判形态。
 */
export const firstStatementIn = (
  node: Node | null | undefined,
  containerTypes: ReadonlySet<string>,
): Node | undefined => {
  let current = node ?? undefined;
  // namedChildren[0] 严格下钻，循环必然终止。
  while (current && containerTypes.has(current.type)) current = current.namedChildren[0];
  return current;
};

export interface GuardClauseSemantics {
  /** 跳转语句节点类型（return/throw/break/continue/goto/fallthrough…）。 */
  readonly jumpTypes: ReadonlySet<string>;
  /** 需要下钻的包裹层节点类型（块、语句列表、表达式语句包装）。 */
  readonly containerTypes: ReadonlySet<string>;
}

/**
 * 卫语句判据的**唯一权威实现**：语言只声明“什么算跳转”和“什么算包裹层”，
 * 判据本身不再由各语言复制。带/不带花括号的单语句形态因此天然等价。
 */
export const createGuardClauseDetector = (
  semantics: GuardClauseSemantics,
): ((ifNode: Node) => boolean) =>
  (ifNode) => {
    const first = firstStatementIn(ifNode.childForFieldName?.("consequence"), semantics.containerTypes);
    return first !== undefined && semantics.jumpTypes.has(first.type);
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
  const callCounts: Record<string, number> = {};
  const shape = { ordinaryIf: 0, guardIf: 0, caseCount: 0 };
  const visit = (current: Node, isRoot = false): number => {
    // Nested functions own their own complexity and calls. They are collected by
    // the outer traversal rather than being folded into the containing function.
    if (!isRoot && semantics.functionTypes.has(current.type)) return 0;
    if (semantics.callNodeTypes.has(current.type)) {
      const target = semantics.callTarget(current);
      if (target) {
        calls.push(target.name);
        callCounts[target.name] = (callCounts[target.name] ?? 0) + 1;
      }
    }
    const kind = semantics.classifyBranch(current);
    if (kind === "ordinary") shape.ordinaryIf += 1;
    else if (kind === "guard") shape.guardIf += 1;
    else if (kind === "case") shape.caseCount += 1;
    return branchWeight(kind)
      + current.children.reduce((sum, child) => sum + visit(child), 0);
  };
  // 先完成遍历再读 shape：形态计数与加权值来自同一次遍历，避免两套口径。
  const branchCount = visit(node, true);
  return {
    name: semantics.functionName(node),
    line: node.startPosition.row + 1,
    branchCount,
    calls: [...new Set(calls)],
    callCounts,
    ordinaryBranches: shape.ordinaryIf,
    guardBranches: shape.guardIf,
    caseBranches: shape.caseCount,
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
