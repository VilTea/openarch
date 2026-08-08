import type { Node } from "web-tree-sitter";
import { directTypeName, type InvocationBindingSemantics } from "./InvocationBindingFacts";

const parameterBindings = (node: Node): ReturnType<InvocationBindingSemantics["bindingsForNode"]> =>
  (node.childForFieldName?.("parameters")?.namedChildren ?? []).flatMap((parameter) => {
    const name = parameter.childForFieldName?.("pattern")?.text;
    const target = directTypeName(parameter.childForFieldName?.("type"));
    return name && target ? [{ name, binding: { target, evidence: "parameter_annotation" as const } }] : [];
  });

const declaratorBindings = (node: Node, bindings: ReadonlyMap<string, { target: string }>): ReturnType<InvocationBindingSemantics["bindingsForNode"]> => {
  const name = node.childForFieldName?.("name")?.text;
  const value = node.childForFieldName?.("value");
  const target = directTypeName(node.childForFieldName?.("type"))
    ?? directTypeName(value?.childForFieldName?.("constructor"))
    ?? (value?.type === "identifier" ? bindings.get(value.text)?.target : undefined);
  return name && target ? [{ name, binding: { target, evidence: "local_assignment" as const } }] : [];
};

const fieldBindings = (node: Node): ReturnType<InvocationBindingSemantics["bindingsForNode"]> => {
  const name = node.childForFieldName?.("name")?.text;
  const target = directTypeName(node.childForFieldName?.("type"));
  return name && target ? [{ name: `this.${name}`, binding: { target, evidence: "field_assignment" as const } }] : [];
};

/** Invocation binding semantics for TypeScript/JavaScript syntax. */
export const tsBindingSemantics: InvocationBindingSemantics = {
  scopeTypes: new Set(["function_declaration", "method_definition", "arrow_function"]),
  bindingsForNode: (node, bindings) => {
    if (["function_declaration", "method_definition", "arrow_function"].includes(node.type)) return parameterBindings(node);
    if (node.type === "variable_declarator") return declaratorBindings(node, bindings);
    if (node.type === "public_field_definition") return fieldBindings(node);
    return [];
  },
  callForNode: (node, bindings) => {
    if (node.type !== "call_expression") return undefined;
    const target = node.childForFieldName?.("function");
    const receiver = target?.type === "member_expression" ? target.childForFieldName?.("object")?.text : undefined;
    const method = target?.type === "member_expression" ? target.childForFieldName?.("property")?.text : undefined;
    const binding = receiver ? bindings.get(receiver) : undefined;
    return receiver && method && binding ? { receiver, method, binding } : undefined;
  },
};
