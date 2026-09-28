// packages/core/src/adapter/semantic-relations/RustSemanticSyntax.ts
//
// Rust 语言映射（纯语法半层）：把 tree-sitter query 命中的语法事实映射为
// 关系候选、锚点与工作区风险。这一层不持有 LSP 会话、进程或文件生命周期，
// 只接受已注入的 `ParserService` 与内存文本；`#[cfg]` 判据与 symbol-use
// 共用同一权威入口。
//
// 与 `RustSemanticRelationProvider.ts` 的分工：provider 负责 LSP 会话/进程
// 生命周期、kernel 契约与报告装配；本模块只回答"这段 Rust 源码里有什么、
// 哪个类型名是锚点"。两者拆开是为了让纯映射层可被独立特征化与测试。
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { ParserService, QueryCapture, QueryMatch } from "../../port/ParserService";
import type { SemanticRelationFact, SemanticRelationSymbol } from "../../semantic-relations/types";
import { RUST_CFG_RISK_QUERY } from "../symbol-use/RustSymbolUseProvider";
import { captureOf } from "./semanticRelationShared";

export type RustSymbolKind = "struct" | "enum" | "trait";

export interface RustDeclaration {
  readonly file: string;
  readonly name: string;
  readonly kind: RustSymbolKind;
  readonly qualifiedName: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startIndex: number;
}

export interface RustImpl {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly typeRef: QueryCapture;
  readonly traitRef?: QueryCapture;
  resolvedSource?: RustDeclaration | null;
}

export interface TypeAnchor {
  readonly name: string;
  readonly startIndex: number;
}

export interface RelationCandidate {
  readonly kind: SemanticRelationFact["kind"];
  readonly file: string;
  readonly line: number;
  readonly target: TypeAnchor;
  readonly source?: RustDeclaration;
  readonly sourceImpl?: RustImpl;
}

export interface RustTarget {
  readonly declaration: RustDeclaration;
  readonly file: string;
}

export interface RustModuleRange {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

export const DECLARATION_QUERY = "[(struct_item name: (type_identifier) @name) @struct (enum_item name: (type_identifier) @name) @enum (trait_item name: (type_identifier) @name) @trait]";
export const MODULE_QUERY = "(mod_item name: (identifier) @modName body: (declaration_list) @modBody)";
export const IMPL_QUERY = "(impl_item type: (_) @typeRef) @impl";
export const TRAIT_IMPL_QUERY = "(impl_item trait: (_) @traitRef type: (_) @typeRef) @impl";
export const FIELD_QUERY = "(field_declaration name: (field_identifier) @fieldName type: (_) @typeRef)";
export const PARAMETER_QUERY = "(function_item parameters: (parameters (parameter type: (_) @typeRef)))";
export const RETURN_QUERY = "(function_item return_type: (_) @typeRef)";
export const STRUCT_EXPRESSION_QUERY = "(struct_expression name: (type_identifier) @typeRef)";
export const MACRO_QUERY = "(macro_invocation) @macro";
export const ATTR_IDENTIFIER_QUERY = "(attribute_item (attribute (identifier) @name))";
export const ATTR_SCOPED_QUERY = "(attribute_item (attribute (scoped_identifier) @name))";

/**
 * Resolves the type name a definition request must point at. Rust type nodes
 * are a closed set of node types but QueryCapture deliberately does not expose
 * the node type, so the anchor is derived from the captured text:
 * - references/pointers are unwrapped (`&'a mut Request` -> `Request`),
 * - generic arguments are cut at the first `<` (`Vec<u8>` -> `Vec`),
 * - path types keep their last segment (`crate::foo::Bar<T>` -> `Bar`).
 * Structural type forms (tuple/array/function/dyn/impl) cannot name a
 * repository struct/enum/trait directly and are skipped, never guessed.
 */
export const typeAnchorFor = (source: string, capture: QueryCapture): TypeAnchor | undefined => {
  const startIndex = capture.startIndex;
  if (startIndex === undefined || capture.endIndex === undefined) return undefined;
  const original = capture.text;
  if (!original.trim()) return undefined;
  if (/^(\(|\[|!|fn\b|dyn\b|impl\b)/.test(original.trim())) return undefined;
  let body = original;
  let removed = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const stripped = body
      .replace(/^&\s*(?:'[A-Za-z_][A-Za-z0-9_]*\s*)?(?:mut\s+)?/, "")
      .replace(/^\*\s*(?:const|mut)\s*/, "");
    if (stripped === body) break;
    removed += body.length - stripped.length;
    body = stripped;
  }
  if (!body.trim()) return undefined;
  const genericAt = body.indexOf("<");
  const rawHead = genericAt >= 0 ? body.slice(0, genericAt) : body;
  const leading = rawHead.length - rawHead.trimStart().length;
  const head = rawHead.slice(leading);
  if (!head || /^(\(|\[|!|fn\b|dyn\b|impl\b|_)/.test(head)) return undefined;
  const lastSeparator = head.lastIndexOf("::");
  const segment = lastSeparator >= 0 ? head.slice(lastSeparator + 2) : head;
  const match = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(segment);
  if (!match) return undefined;
  return { name: match[1], startIndex: startIndex + removed + leading + (lastSeparator >= 0 ? lastSeparator + 2 : 0) + match.index };
};

export const declarationFor = (
  declarations: readonly RustDeclaration[],
  file: string,
  line: number,
): RustDeclaration | undefined =>
  declarations.find((declaration) => declaration.file === file && line >= declaration.startLine && line <= declaration.endLine);

export const implFor = (impls: readonly RustImpl[], file: string, line: number): RustImpl | undefined =>
  impls.find((impl) => impl.file === file && line >= impl.startLine && line <= impl.endLine);

export const declarationSymbol = (declaration: RustDeclaration, file: string): SemanticRelationSymbol => ({
  id: `rust:repository:${file}:${declaration.qualifiedName}`,
  name: declaration.name,
  kind: declaration.kind,
  scope: "repository",
  file,
  line: declaration.startLine,
});

export const SOURCE_KINDS: readonly RustSymbolKind[] = ["struct", "enum", "trait"];
export const TARGET_KINDS: Readonly<Record<SemanticRelationFact["kind"], readonly RustSymbolKind[]>> = {
  implements: ["trait"],
  field_type: ["struct", "enum", "trait"],
  parameter_type: ["struct", "enum", "trait"],
  return_type: ["struct", "enum", "trait"],
  instantiates: ["struct"],
  extends: [],
  embeds: [],
};

/** A bare `impl Type` carries no trait, so it never produces an `implements` fact. */
export const implementsSourceKinds: readonly RustSymbolKind[] = ["struct", "enum"];

export const queryRust = (parser: ParserService, file: string, pattern: string): Promise<readonly QueryMatch[]> =>
  Effect.runPromise(parser.query(file, pattern).pipe(Effect.catchAll(() => Effect.succeed([]))));

/** `collectRustDeclarations` 需要的问题集：模块拓扑与类型声明。 */
interface RustDeclarationQueries {
  readonly modules: readonly QueryMatch[];
  readonly declarations: readonly QueryMatch[];
}

/** `collectRustCandidates` 需要的问题集：impl 归属与类型引用位置。 */
interface RustCandidateQueries {
  readonly impls: readonly QueryMatch[];
  readonly traitImpls: readonly QueryMatch[];
  readonly fields: readonly QueryMatch[];
  readonly parameters: readonly QueryMatch[];
  readonly returns: readonly QueryMatch[];
  readonly structExpressions: readonly QueryMatch[];
}

/** `collectRustSyntaxWorkspaceRisks` 需要的问题集：宏展开与条件编译。 */
interface RustWorkspaceRiskQueries {
  readonly macros: readonly QueryMatch[];
  readonly attributeIdentifiers: readonly QueryMatch[];
  readonly attributeScoped: readonly QueryMatch[];
  readonly cfgRisks: readonly QueryMatch[];
}

/**
 * 每个收集器各有一个"本次要问的问题集"，取代原先散落在收集器体内的 ad hoc `queryRust`
 * 调用：问题集与消费它的收集器同名相邻，读收集器时不必再逐行拼凑它到底问了哪几条。
 * 问题集是**每次收集器调用各取一份**（不跨调用缓存：文件内容可变，缓存会把"重新读盘"
 * 语义换成陈旧结果）；每个 pattern 的发起次数与改造前逐条相同，因此语法事实一份不少。
 */
const rustDeclarationQueries = async (parser: ParserService, file: string): Promise<RustDeclarationQueries> => {
  const [modules, declarations] = await Promise.all([
    queryRust(parser, file, MODULE_QUERY),
    queryRust(parser, file, DECLARATION_QUERY),
  ]);
  return { modules, declarations };
};

const rustCandidateQueries = async (parser: ParserService, file: string): Promise<RustCandidateQueries> => {
  const [impls, traitImpls, fields, parameters, returns, structExpressions] = await Promise.all([
    queryRust(parser, file, IMPL_QUERY),
    queryRust(parser, file, TRAIT_IMPL_QUERY),
    queryRust(parser, file, FIELD_QUERY),
    queryRust(parser, file, PARAMETER_QUERY),
    queryRust(parser, file, RETURN_QUERY),
    queryRust(parser, file, STRUCT_EXPRESSION_QUERY),
  ]);
  return { impls, traitImpls, fields, parameters, returns, structExpressions };
};

const rustWorkspaceRiskQueries = async (parser: ParserService, file: string): Promise<RustWorkspaceRiskQueries> => {
  const [macros, attributeIdentifiers, attributeScoped, cfgRisks] = await Promise.all([
    queryRust(parser, file, MACRO_QUERY),
    queryRust(parser, file, ATTR_IDENTIFIER_QUERY),
    queryRust(parser, file, ATTR_SCOPED_QUERY),
    // 与 symbol-use 共用同一 `#[cfg]` 语法判据（同一概念一个权威入口）。
    queryRust(parser, file, RUST_CFG_RISK_QUERY),
  ]);
  return { macros, attributeIdentifiers, attributeScoped, cfgRisks };
};

export const readCargoWorkspaceRisk = (cargoToml: string): string | undefined => {
  try {
    const manifest = readFileSync(cargoToml, "utf8");
    return /^\s*\[workspace\]/m.test(manifest)
      ? "Cargo workspace manifests are outside the calibrated single-crate semantic-relations scope"
      : undefined;
  } catch {
    return "Rust Cargo.toml could not be read";
  }
};

/** 只做 manifest 与文件拓扑层面的范围判定；`#[cfg]` 是语法事实，见
 *  `collectRustSyntaxWorkspaceRisks`（注释里的 `// #[cfg(...)]` 不应伪造该风险）。 */
export const collectRustWorkspaceRisks = (
  cwd: string,
  files: readonly string[],
): readonly string[] => {
  const risks: string[] = [];
  const cargoToml = join(cwd, "Cargo.toml");
  const cargoRisk = existsSync(cargoToml)
    ? readCargoWorkspaceRisk(cargoToml)
    : "Rust semantic relations require a Cargo.toml crate rooted at the governed project";
  risks.push(...(cargoRisk ? [cargoRisk] : []));
  risks.push(...(files.some((file) => basename(file) === "build.rs")
    ? ["Rust build scripts are outside the calibrated semantic-relations scope"]
    : []));
  return risks;
};

export const collectRustSyntaxWorkspaceRisks = async (
  parser: ParserService,
  cwd: string,
  files: readonly string[],
): Promise<readonly string[]> => {
  const risks = [...collectRustWorkspaceRisks(cwd, files)];
  for (const file of files) {
    const queries = await rustWorkspaceRiskQueries(parser, file);
    if (queries.cfgRisks.length > 0) {
      risks.push("Rust conditional compilation is outside the calibrated semantic-relations scope");
    }
    if (queries.macros.length > 0) {
      risks.push("Rust macro expansion is outside the calibrated semantic-relations scope");
    }
    if (queries.attributeIdentifiers.some((match) => {
      const name = captureOf(match, "name")?.text;
      return name !== undefined && ["derive", "proc_macro", "proc_macro_attribute", "proc_macro_derive"].includes(name);
    })) {
      risks.push("Rust derive or proc-macro expansion is outside the calibrated semantic-relations scope");
    }
    if (queries.attributeScoped.length > 0) {
      risks.push("Rust path attribute macros are outside the calibrated semantic-relations scope");
    }
  }
  return [...new Set(risks)];
};

export const moduleRangesFromMatches = (matches: readonly QueryMatch[]): RustModuleRange[] => {
  const ranges: RustModuleRange[] = [];
  for (const match of matches) {
    const name = captureOf(match, "modName");
    const body = captureOf(match, "modBody");
    if (!name || name.startLine === undefined || !body || body.startLine === undefined || body.endLine === undefined) continue;
    ranges.push({ name: name.text, startLine: body.startLine, endLine: body.endLine });
  }
  return ranges;
};

export const declarationsFromRustMatches = (
  file: string,
  matches: readonly QueryMatch[],
  moduleRanges: readonly RustModuleRange[],
): RustDeclaration[] => {
  const declarations: RustDeclaration[] = [];
  for (const match of matches) {
    const name = captureOf(match, "name");
    const item = captureOf(match, "struct") ?? captureOf(match, "enum") ?? captureOf(match, "trait");
    if (!name || !item || name.startLine === undefined || name.startIndex === undefined || item.endLine === undefined) continue;
    const kind: RustSymbolKind = captureOf(match, "struct") ? "struct" : captureOf(match, "enum") ? "enum" : "trait";
    const enclosingModules = moduleRanges
      .filter((module) => name.startLine! >= module.startLine && name.startLine! <= module.endLine)
      .sort((left, right) => left.startLine - right.startLine)
      .map((module) => module.name);
    declarations.push({
      file,
      name: name.text,
      kind,
      qualifiedName: [...enclosingModules, name.text].join("::"),
      startLine: name.startLine,
      endLine: item.endLine,
      startIndex: name.startIndex,
    });
  }
  return declarations;
};

export const collectRustDeclarations = async (
  parser: ParserService,
  files: readonly string[],
): Promise<readonly RustDeclaration[]> => {
  const declarations: RustDeclaration[] = [];
  for (const file of files) {
    const queries = await rustDeclarationQueries(parser, file);
    declarations.push(...declarationsFromRustMatches(file, queries.declarations, moduleRangesFromMatches(queries.modules)));
  }
  return declarations;
};

export const collectRustImpls = (
  file: string,
  implMatches: readonly QueryMatch[],
  traitImplMatches: readonly QueryMatch[],
): RustImpl[] => {
  const traitRefByType = new Map<string, QueryCapture>();
  for (const match of traitImplMatches) {
    const traitRef = captureOf(match, "traitRef");
    const typeRef = captureOf(match, "typeRef");
    if (!traitRef || !typeRef || typeRef.startIndex === undefined || typeRef.endIndex === undefined) continue;
    traitRefByType.set(`${typeRef.startIndex}:${typeRef.endIndex}`, traitRef);
  }
  const impls: RustImpl[] = [];
  for (const match of implMatches) {
    const item = captureOf(match, "impl");
    const typeRef = captureOf(match, "typeRef");
    if (!item || !typeRef || item.startLine === undefined || item.endLine === undefined) continue;
    const traitRef = typeRef.startIndex !== undefined && typeRef.endIndex !== undefined
      ? traitRefByType.get(`${typeRef.startIndex}:${typeRef.endIndex}`)
      : undefined;
    impls.push(traitRef
      ? { file, startLine: item.startLine, endLine: item.endLine, typeRef, traitRef }
      : { file, startLine: item.startLine, endLine: item.endLine, typeRef });
  }
  return impls;
};

/**
 * 三个 push 收集器共用的捕获前奏：按捕获名取引用、要求它有行号与偏移边界、再算出锚点。
 * 判据只在这里出现一次，避免同一条"跳过还是产出"的规则在三处各自演化。
 */
const rustTargetOf = (
  sourceText: string,
  match: QueryMatch,
  captureName: string,
): { readonly target: TypeAnchor; readonly line: number } | undefined => {
  const ref = captureOf(match, captureName);
  if (!ref || ref.startLine === undefined) return undefined;
  if (ref.startIndex === undefined || ref.endIndex === undefined) return undefined;
  const target = typeAnchorFor(sourceText, ref);
  return target ? { target, line: ref.startLine } : undefined;
};

export const pushRustDeclarationTargets = (
  candidates: RelationCandidate[],
  file: string,
  sourceText: string,
  matches: readonly QueryMatch[],
  kind: SemanticRelationFact["kind"],
  sourceOf: (match: QueryMatch) => RustDeclaration | undefined,
): void => {
  for (const match of matches) {
    const target = rustTargetOf(sourceText, match, "typeRef");
    if (!target) continue;
    const source = sourceOf(match);
    if (!source) continue;
    candidates.push({ kind, file, line: target.line, target: target.target, source });
  }
};

export const pushRustImplTargets = (
  candidates: RelationCandidate[],
  file: string,
  sourceText: string,
  matches: readonly QueryMatch[],
  kind: SemanticRelationFact["kind"],
  sourceOf: (match: QueryMatch) => RustImpl | undefined,
): void => {
  for (const match of matches) {
    const target = rustTargetOf(sourceText, match, "typeRef");
    if (!target) continue;
    const impl = sourceOf(match);
    if (!impl || !typeAnchorFor(sourceText, impl.typeRef)) continue;
    candidates.push({ kind, file, line: target.line, target: target.target, sourceImpl: impl });
  }
};

export const pushRustImplementsTargets = (
  candidates: RelationCandidate[],
  file: string,
  sourceText: string,
  impls: readonly RustImpl[],
  matches: readonly QueryMatch[],
): void => {
  for (const match of matches) {
    const typeRef = captureOf(match, "typeRef");
    if (!typeRef) continue;
    const target = rustTargetOf(sourceText, match, "traitRef");
    if (!target) continue;
    const impl = impls.find((entry) =>
      entry.typeRef.startIndex === typeRef.startIndex && entry.typeRef.endIndex === typeRef.endIndex);
    if (!impl || !typeAnchorFor(sourceText, impl.typeRef)) continue;
    candidates.push({ kind: "implements", file, line: target.line, target: target.target, sourceImpl: impl });
  }
};

export const collectRustCandidates = async (
  parser: ParserService,
  files: readonly string[],
  declarations: readonly RustDeclaration[],
  sources: ReadonlyMap<string, string>,
): Promise<readonly RelationCandidate[]> => {
  const candidates: RelationCandidate[] = [];
  for (const file of files) {
    const queries = await rustCandidateQueries(parser, file);

    const fileDeclarations = declarations.filter((declaration) => declaration.file === file);
    const fileImpls = collectRustImpls(file, queries.impls, queries.traitImpls);
    const sourceText = sources.get(file)!;
    const structDeclarations = fileDeclarations.filter((declaration) => declaration.kind === "struct");
    const enclosingStruct = (line: number): RustDeclaration | undefined => declarationFor(structDeclarations, file, line);
    const enclosingImpl = (line: number): RustImpl | undefined => implFor(fileImpls, file, line);

    pushRustDeclarationTargets(candidates, file, sourceText, queries.fields, "field_type", (match) => enclosingStruct(captureOf(match, "typeRef")?.startLine ?? -1));
    pushRustImplTargets(candidates, file, sourceText, queries.parameters, "parameter_type", (match) => enclosingImpl(captureOf(match, "typeRef")?.startLine ?? -1));
    pushRustImplTargets(candidates, file, sourceText, queries.returns, "return_type", (match) => enclosingImpl(captureOf(match, "typeRef")?.startLine ?? -1));
    pushRustImplTargets(candidates, file, sourceText, queries.structExpressions, "instantiates", (match) => enclosingImpl(captureOf(match, "typeRef")?.startLine ?? -1));
    pushRustImplementsTargets(candidates, file, sourceText, fileImpls, queries.traitImpls);
  }
  return candidates;
};

export const canonicalWorkspaceUri = (uri: string): string => {
  try {
    const canonical = pathToFileURL(realpathSync.native(fileURLToPath(uri))).href;
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return process.platform === "win32" ? uri.toLowerCase() : uri;
  }
};
