import ts from "typescript";
import type { SemanticRelationFact, SemanticRelationReport, SemanticRelationSymbol } from "./types";
import {
  aliasTypeScriptSymbol,
  hasCompleteTypeScriptProjectScope,
  loadTypeScriptProjects,
  relativeTypeScriptPath,
} from "../adapter/typescript/TypeScriptProject";
import { isAnalyzableProjectFile, listProjectSourceFiles } from "../projectFiles";

const typeSymbol = (checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined =>
  aliasTypeScriptSymbol(checker, checker.getTypeAtLocation(node).getSymbol() ?? checker.getSymbolAtLocation(node));

const typeKind = (symbol: ts.Symbol): SemanticRelationSymbol["kind"] | undefined => {
  if ((symbol.flags & ts.SymbolFlags.Class) !== 0) return "class";
  if ((symbol.flags & ts.SymbolFlags.Interface) !== 0) return "interface";
  if ((symbol.flags & ts.SymbolFlags.TypeAlias) !== 0) return "type_alias";
  return undefined;
};

const symbolFor = (
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  cwd: string,
): SemanticRelationSymbol | undefined => {
  if (!symbol) return undefined;
  const kind = typeKind(symbol);
  if (!kind) return undefined;
  const declaration = symbol.declarations?.find((candidate) => !candidate.getSourceFile().isDeclarationFile)
    ?? symbol.declarations?.[0];
  const source = declaration?.getSourceFile();
  const repository = source && isAnalyzableProjectFile(source.fileName, { cwd, languages: ["typescript"], population: "production-governance" });
  const qualified = checker.getFullyQualifiedName(symbol);
  const file = repository && source ? relativeTypeScriptPath(cwd, source.fileName) : undefined;
  const line = repository && source && declaration
    ? source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1
    : undefined;
  return {
    id: `typescript:${repository ? "repository" : "external"}:${file ?? qualified}:${qualified}`,
    name: symbol.getName(),
    kind,
    scope: repository ? "repository" : "external",
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
  };
};

const enclosingType = (node: ts.Node, checker: ts.TypeChecker, cwd: string): SemanticRelationSymbol | undefined => {
  let current: ts.Node | undefined = node;
  while (current) {
    if ((ts.isClassDeclaration(current) || ts.isInterfaceDeclaration(current)) && current.name) {
      return symbolFor(checker, aliasTypeScriptSymbol(checker, checker.getSymbolAtLocation(current.name)), cwd);
    }
    current = current.parent;
  }
  return undefined;
};

/** Expand only explicit type syntax; compiler inference and arbitrary child traversal stay outside v1. */
const directTypeNodes = (node: ts.Node | undefined): readonly ts.Node[] => {
  if (!node) return [];
  if (ts.isTypeReferenceNode(node)) return [node.typeName, ...(node.typeArguments ?? []).flatMap(directTypeNodes)];
  if (ts.isExpressionWithTypeArguments(node)) return [node.expression, ...(node.typeArguments ?? []).flatMap(directTypeNodes)];
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) return node.types.flatMap(directTypeNodes);
  if (ts.isArrayTypeNode(node)) return directTypeNodes(node.elementType);
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) return directTypeNodes(node.type);
  return [node];
};

const relationAt = (
  facts: SemanticRelationFact[],
  checker: ts.TypeChecker,
  cwd: string,
  source: SemanticRelationSymbol | undefined,
  targetNode: ts.Node,
  kind: SemanticRelationFact["kind"],
  evidenceNode = targetNode,
): void => {
  if (!source) return;
  const sourceFile = evidenceNode.getSourceFile();
  for (const candidate of directTypeNodes(targetNode)) {
    const target = symbolFor(checker, typeSymbol(checker, candidate), cwd);
    if (!target || target.scope !== "repository") continue;
    facts.push({
      language: "typescript",
      kind,
      source,
      target,
      direct: true,
      evidence: {
        file: relativeTypeScriptPath(cwd, sourceFile.fileName),
        line: sourceFile.getLineAndCharacterOfPosition(evidenceNode.getStart(sourceFile)).line + 1,
      },
    });
  }
};

const collectHeritageRelations = (node: ts.Node, checker: ts.TypeChecker, cwd: string, facts: SemanticRelationFact[]): void => {
  if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
    const source = symbolFor(checker, aliasTypeScriptSymbol(checker, checker.getSymbolAtLocation(node.name)), cwd);
    for (const clause of node.heritageClauses ?? []) {
      const kind = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
      for (const type of clause.types) relationAt(facts, checker, cwd, source, type, kind, type);
    }
  }
};

const collectPropertyRelations = (node: ts.Node, checker: ts.TypeChecker, cwd: string, facts: SemanticRelationFact[]): void => {
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    if (node.type) relationAt(facts, checker, cwd, enclosingType(node, checker, cwd), node.type, "field_type", node.name);
  }
};

const collectMemberRelations = (node: ts.Node, checker: ts.TypeChecker, cwd: string, facts: SemanticRelationFact[]): void => {
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isConstructorDeclaration(node)) {
    const source = enclosingType(node, checker, cwd);
    for (const parameter of node.parameters) {
      if (parameter.type) relationAt(facts, checker, cwd, source, parameter.type, "parameter_type", parameter.name);
    }
    if (node.type) relationAt(facts, checker, cwd, source, node.type, "return_type", node.name ?? node);
  }
};

const collectConstructionRelations = (node: ts.Node, checker: ts.TypeChecker, cwd: string, facts: SemanticRelationFact[]): void => {
  if (ts.isNewExpression(node)) {
    relationAt(facts, checker, cwd, enclosingType(node, checker, cwd), node.expression, "instantiates", node.expression);
  }
};

type RelationCollector = (node: ts.Node, checker: ts.TypeChecker, cwd: string, facts: SemanticRelationFact[]) => void;
const relationCollectors: readonly RelationCollector[] = [
  collectHeritageRelations,
  collectPropertyRelations,
  collectMemberRelations,
  collectConstructionRelations,
];

const visit = (node: ts.Node, checker: ts.TypeChecker, cwd: string, facts: SemanticRelationFact[]): void => {
  for (const collector of relationCollectors) collector(node, checker, cwd, facts);
  ts.forEachChild(node, (child) => visit(child, checker, cwd, facts));
};

const uniqueFacts = (facts: readonly SemanticRelationFact[]): readonly SemanticRelationFact[] => {
  const byIdentity = new Map<string, SemanticRelationFact>();
  for (const fact of facts) {
    const key = `${fact.source.id}\0${fact.kind}\0${fact.target.id}\0${fact.evidence.file}\0${fact.evidence.line}`;
    byIdentity.set(key, fact);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.evidence.file.localeCompare(right.evidence.file)
    || left.evidence.line - right.evidence.line
    || left.kind.localeCompare(right.kind)
    || left.source.id.localeCompare(right.source.id)
    || left.target.id.localeCompare(right.target.id));
};

/** Compiler-backed direct class/interface relations for a readable TypeScript project. */
export const collectTypeScriptSemanticRelations = (cwd: string): SemanticRelationReport => {
  const sourceFiles = listProjectSourceFiles({ cwd, languages: ["typescript"], population: "production-governance" });
  const projects = loadTypeScriptProjects(cwd, sourceFiles);
  const completeScope = hasCompleteTypeScriptProjectScope(projects, sourceFiles);
  if (projects.length === 0 || projects.some((project) => project.parsed.errors.length > 0)) {
    return {
      origin: { language: "typescript", providerId: "typescript-semantic-relations", evidenceSource: "compiler" },
      state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason: "tsconfig.json could not be read as a complete TypeScript project" },
      facts: [],
    };
  }
  const facts: SemanticRelationFact[] = [];
  for (const { checker, sources } of projects) {
    for (const source of sources) visit(source, checker, cwd, facts);
  }
  return {
    origin: { language: "typescript", providerId: "typescript-semantic-relations", evidenceSource: "compiler" },
    state: {
      availability: completeScope ? "available" : "partial",
      coverage: {
        symbols: completeScope ? "complete" : "partial",
        relations: completeScope ? "complete" : "partial",
      },
      ...(completeScope ? {} : { reason: "some governed source files are outside the resolved TypeScript project" }),
    },
    facts: uniqueFacts(facts),
    scope: { workspaceFingerprint: projects.map((project) => relativeTypeScriptPath(cwd, project.configPath)).join(",") },
  };
};
