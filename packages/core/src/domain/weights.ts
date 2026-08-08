// packages/core/src/domain/weights.ts
/** 变更类型（design v5.2 §7.2） */
export type ChangeKind =
  | "interface_add_remove"
  | "class_add_remove"
  | "public_method_sig"
  | "function_sig"
  | "field_add_remove"
  | "compatible_field_add"
  | "function_body"
  | "branch_add"
  | "dependency_remove"
  | "dependency_add"
  | "comment_whitespace";

/** λ_ast 权重表（design v5.2 §7.2 完整对照表，不可变常量） */
export const LAMBDA_AST: Readonly<Record<ChangeKind, number>> = Object.freeze({
  interface_add_remove: 100,
  class_add_remove: 80,
  public_method_sig: 60,
  function_sig: 50,
  field_add_remove: 40,
  compatible_field_add: 5,
  function_body: 10,
  branch_add: 5,
  dependency_remove: 15,
  dependency_add: 5,
  comment_whitespace: 0,
});

/** A source-compatible contract extension does not require existing consumers to change. */
export const requiresDependentSync = (changeKind: ChangeKind): boolean =>
  changeKind !== "compatible_field_add";
