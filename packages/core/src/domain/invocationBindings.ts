/**
 * A parser-confirmed receiver binding for one invocation. This is intentionally
 * narrower than data-flow analysis: unresolved aliases and dynamic dispatch do
 * not appear as negative facts.
 */
export interface InvocationBindingFact {
  readonly path: string;
  readonly receiver: string;
  readonly method: string;
  /** Canonical symbol name after a local import/assignment alias is resolved. */
  readonly target: string;
  readonly evidence: "parameter_annotation" | "import_alias" | "local_assignment" | "field_assignment";
  readonly startLine?: number;
  readonly endLine?: number;
}
