import type { Node } from "web-tree-sitter";
import type { SemanticDeclaration, SemanticDeclarationKind, SemanticSurface } from "../../domain/ast";

/**
 * 成员可见性判定的输入（认知点原则：可见性规则只有一个权威入口，语言只提供语义参数）。
 *
 * 这里必须同时给出「外层是否可见」与「外层是什么容器」，因为两者的组合含义**因语言而异**：
 * - TypeScript 类成员默认 public ⇒ 继承外层的 public（`TsDeclarationSyntax`）；
 * - Java 类成员默认**包级私有**，只有接口/注解成员才是隐式 public ⇒ 类成员**不继承**；
 * - Rust 结构体/枚举字段默认私有，trait 成员才隐式公开 ⇒ 与 Java 同型；
 * - Go 由首字母大小写决定，Python 由下划线前缀决定 ⇒ 两者都不使用本上下文。
 *
 * 0.1.5 的缺陷正是把前两者混为一谈：`inherited || hasPublicModifier(node)`
 * 让公有类里的 private/protected/包级私有成员全部被标成 public，
 * 新增的内部私有助手因此被当成公共合同变更（public_method_sig）。
 */
export interface DeclarationVisibilityContext {
  /** 外层声明是否可见（顶层为 false；`export`/`modifiers` 包裹层由语言决定语义）。 */
  readonly inheritedPublic: boolean;
  /** 最近的容器声明类型；顶层为 undefined。语言据此决定成员可见性能否继承。 */
  readonly containerKind: SemanticDeclarationKind | undefined;
}

export interface DeclarationSyntax {
  readonly isImport: (node: Node) => boolean;
  readonly isIgnored: (node: Node) => boolean;
  readonly isWrapper: (node: Node) => boolean;
  readonly kindOf: (node: Node) => SemanticDeclarationKind | undefined;
  readonly nameOf: (node: Node) => string | undefined;
  readonly isPublic: (node: Node, context: DeclarationVisibilityContext) => boolean;
  readonly contractCompatibilityOf?: (node: Node) => SemanticDeclaration["contractCompatibility"];
  readonly isReExport?: (node: Node) => boolean;
  readonly bodyOf: (node: Node) => Node | undefined;
}

const compact = (text: string): string => text.replace(/\s+/g, " ").trim();

const declarationFrom = (
  node: Node,
  kind: SemanticDeclarationKind,
  id: string,
  isPublic: boolean,
  contractCompatibility: SemanticDeclaration["contractCompatibility"],
  isReExport: boolean,
  body: Node | undefined,
): SemanticDeclaration => ({
  id,
  kind,
  isPublic,
  ...(contractCompatibility ? { contractCompatibility } : {}),
  ...(isReExport ? { provenance: "reexport" as const } : {}),
  signature: compact(body ? node.text.slice(0, Math.max(0, body.startIndex - node.startIndex)) : node.text),
  ...(body ? { body: compact(body.text) } : {}),
});

/**
 * Traverses only declaration-bearing syntax. Language strategies supply node
 * names and visibility semantics; the traversal and stable member identities
 * remain shared so a new language cannot grow a parallel diff engine.
 */
export const collectSemanticSurface = (root: Node, syntax: DeclarationSyntax): SemanticSurface => {
  const declarations: SemanticDeclaration[] = [];
  const unsupportedTopLevel: string[] = [];

  const visit = (node: Node, scope: readonly string[], context: DeclarationVisibilityContext, topLevel: boolean): void => {
    if (syntax.isIgnored(node)) return;
    if (syntax.isImport(node)) return;
    if (syntax.isWrapper(node)) {
      if (node.namedChildren.length === 0 && topLevel) unsupportedTopLevel.push(`${node.type}:${compact(node.text)}`);
      // 包裹层（TS 的 export_statement/export_clause、Java 的 modifiers）表示
      // “可见性由包裹语义给出”，不改变当前容器类型。
      const wrapped: DeclarationVisibilityContext = { inheritedPublic: true, containerKind: context.containerKind };
      for (const child of node.namedChildren) visit(child, scope, wrapped, topLevel);
      return;
    }
    const kind = syntax.kindOf(node);
    if (!kind) {
      if (topLevel && node.type !== "comment") unsupportedTopLevel.push(`${node.type}:${compact(node.text)}`);
      return;
    }
    const name = syntax.nameOf(node);
    if (!name) {
      if (topLevel) unsupportedTopLevel.push(`${node.type}:${compact(node.text)}`);
      return;
    }
    const body = syntax.bodyOf(node);
    const id = [...scope, name].join(".");
    const publicDeclaration = syntax.isPublic(node, context);
    declarations.push(declarationFrom(
      node, kind, id, publicDeclaration, syntax.contractCompatibilityOf?.(node), syntax.isReExport?.(node) ?? false, body,
    ));

    if (kind === "interface" || kind === "class") {
      // 成员上下文：容器类型必须一起传下去，否则语言无法区分
      // “类成员默认私有”（Java/Rust）与“类成员默认公开”（TypeScript）。
      const members: DeclarationVisibilityContext = { inheritedPublic: publicDeclaration, containerKind: kind };
      for (const child of body?.namedChildren ?? []) visit(child, [...scope, name], members, false);
    }
  };

  for (const child of root.namedChildren) visit(child, [], { inheritedPublic: false, containerKind: undefined }, true);
  return { declarations, unsupportedTopLevel };
};
