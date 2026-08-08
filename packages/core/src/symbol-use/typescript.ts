import ts from "typescript";
import type { SymbolReference, SymbolUseFact } from "./types";
import {
  aliasTypeScriptSymbol,
  relativeTypeScriptPath,
} from "../adapter/typescript/TypeScriptProject";

/** Any explicit module export is public: a single `src/index.ts` convention is not a semantic boundary. */
export const publicSymbols = (sources: readonly ts.SourceFile[], checker: ts.TypeChecker): ReadonlySet<ts.Symbol> =>
  new Set(sources.flatMap((source) => {
    const moduleSymbol = checker.getSymbolAtLocation(source);
    return moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
  }).map((symbol) => aliasTypeScriptSymbol(checker, symbol)).filter((symbol): symbol is ts.Symbol => !!symbol));

const isDeclarationIdentifier = (node: ts.Node, symbol: ts.Symbol): boolean =>
  (symbol.declarations ?? []).some((declaration) => declaration === node.parent || declaration === node);

export interface PropertyCandidate {
  readonly identity: string;
  readonly declaration: SymbolUseFact["declaration"];
  readonly publicSurface: SymbolUseFact["publicSurface"];
}

interface CandidateContext {
  readonly candidates: Map<string, PropertyCandidate>;
  readonly checker: ts.TypeChecker;
  readonly publicApi: ReadonlySet<ts.Symbol>;
  readonly cwd: string;
  readonly sourceFile: ts.SourceFile;
}

interface CandidateInput {
  /**
   * Only declaration names with compiler-backed symbols participate. This
   * includes `#private` and literal computed members, but never arbitrary
   * computed expressions.
   */
  readonly name: ts.DeclarationName;
  /** Some declaration names have no location symbol; their containing type does. */
  readonly symbol?: ts.Symbol;
  readonly kind: SymbolUseFact["declaration"]["kind"];
  readonly displayName?: string;
  /** Interface members inherit publicness from their containing interface. */
  readonly publicSymbol?: ts.Symbol;
  /** Object values may escape through returns or arguments without a named API boundary. */
  readonly publicSurface?: SymbolUseFact["publicSurface"];
}

const publicSurfaceFor = (symbol: ts.Symbol, publicApi: ReadonlySet<ts.Symbol>): SymbolUseFact["publicSurface"] =>
  publicApi.has(symbol) ? "declared-public" : "internal";

/** Names such as `[expression]` have no stable repository-local symbol identity. */
const declarationNameText = (name: ts.DeclarationName): string | undefined =>
  ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : ts.isComputedPropertyName(name) && (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression))
      ? name.expression.text
      : undefined;

/** Access sites can receive transient symbols; declaration locations stay stable across both checker views. */
const symbolIdentity = (symbol: ts.Symbol, cwd: string): string | undefined => {
  const declarations = (symbol.declarations ?? []).filter((declaration) => !declaration.getSourceFile().isDeclarationFile);
  if (declarations.length === 0) return undefined;
  return declarations.map((declaration) => {
    const sourceFile = declaration.getSourceFile();
    return `${relativeTypeScriptPath(cwd, sourceFile.fileName)}:${declaration.getStart(sourceFile)}`;
  }).sort().join("\0");
};

const addCandidate = (
  context: CandidateContext,
  input: CandidateInput,
): void => {
  if (!declarationNameText(input.name)) return;
  const symbol = aliasTypeScriptSymbol(context.checker, input.symbol ?? context.checker.getSymbolAtLocation(input.name));
  const identity = symbol && symbolIdentity(symbol, context.cwd);
  if (!symbol || !identity || context.candidates.has(identity)) return;
  context.candidates.set(identity, {
    identity,
    declaration: {
      file: relativeTypeScriptPath(context.cwd, context.sourceFile.fileName),
      name: input.displayName ?? declarationNameText(input.name)!,
      kind: input.kind,
      line: context.sourceFile.getLineAndCharacterOfPosition(input.name.getStart(context.sourceFile)).line + 1,
    },
    publicSurface: input.publicSurface ?? publicSurfaceFor(input.publicSymbol ?? symbol, context.publicApi),
  });
};

type ContractMemberKind = "interface-property" | "interface-method" | "type-property" | "type-method";

const contractMemberCandidate = (
  member: ts.TypeElement,
  family: "interface" | "type",
): { readonly name: ts.DeclarationName; readonly kind: ContractMemberKind } | undefined => {
  if (!member.name || !declarationNameText(member.name)) return undefined;
  if (ts.isPropertySignature(member)) return { name: member.name, kind: `${family}-property` };
  if (ts.isMethodSignature(member)) return { name: member.name, kind: `${family}-method` };
  return undefined;
};

const collectContractMemberCandidates = (node: ts.Node, context: CandidateContext): void => {
  const contract = ts.isInterfaceDeclaration(node)
    ? { name: node.name, members: node.members, family: "interface" as const }
    : ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)
      ? { name: node.name, members: node.type.members, family: "type" as const }
      : undefined;
  if (!contract) return;
  const publicSymbol = aliasTypeScriptSymbol(context.checker, context.checker.getSymbolAtLocation(contract.name));
  const contractType = context.checker.getTypeAtLocation(node);
  for (const member of contract.members) {
    const candidate = contractMemberCandidate(member, contract.family);
    if (!candidate) continue;
    addCandidate(context, {
      name: candidate.name,
      kind: candidate.kind,
      symbol: context.checker.getPropertyOfType(contractType, declarationNameText(candidate.name)!),
      displayName: `${contract.name.text}.${declarationNameText(candidate.name)!}`,
      publicSymbol,
    });
  }
};

const collectFunctionDeclarationCandidate = (node: ts.Node, context: CandidateContext): void => {
  if (ts.isFunctionDeclaration(node) && node.name) addCandidate(context, { name: node.name, kind: "function" });
};

const collectClassDeclarationCandidate = (node: ts.Node, context: CandidateContext): void => {
  if (ts.isClassDeclaration(node) && node.name) addCandidate(context, { name: node.name, kind: "class" });
};

const functionValueName = (node: ts.Node): ts.Identifier | undefined => {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return undefined;
  return node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? node.name : undefined;
};

const collectFunctionValueCandidate = (node: ts.Node, context: CandidateContext): void => {
  const name = functionValueName(node);
  if (name) addCandidate(context, { name, kind: "function" });
};

const classForMember = (node: ts.Node): ts.ClassDeclaration | undefined =>
  ts.isClassDeclaration(node.parent) && node.parent.name ? node.parent : undefined;

/** Computed literal and `#private` member names resolve from the instance type, not the name node. */
const classMemberSymbol = (
  node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.PropertyDeclaration,
  classDeclaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
): ts.Symbol | undefined => {
  const name = declarationNameText(node.name);
  if (!name) return undefined;
  const staticMember = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
  const classSymbol = classDeclaration.name && checker.getSymbolAtLocation(classDeclaration.name);
  const ownerType = staticMember && classSymbol
    ? checker.getTypeOfSymbolAtLocation(classSymbol, classDeclaration)
    : checker.getTypeAtLocation(classDeclaration);
  return checker.getPropertyOfType(ownerType, name);
};

/** A call through an interface/base type resolves to that contract, not necessarily the implementation member. */
const fulfillsInheritedMemberContract = (
  node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.PropertyDeclaration,
  classDeclaration: ts.ClassDeclaration,
  checker: ts.TypeChecker,
): boolean => {
  const name = declarationNameText(node.name);
  if (!name) return false;
  return (classDeclaration.heritageClauses ?? []).some((clause) => clause.types.some((type) =>
    checker.getPropertyOfType(checker.getTypeAtLocation(type), name) !== undefined));
};

const classMemberSurface = (
  node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.PropertyDeclaration,
  classDeclaration: ts.ClassDeclaration,
  context: CandidateContext,
): SymbolUseFact["publicSurface"] => {
  if (ts.isPrivateIdentifier(node.name) || node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)) return "internal";
  if (fulfillsInheritedMemberContract(node, classDeclaration, context.checker)) return "unknown";
  const classSymbol = aliasTypeScriptSymbol(context.checker, context.checker.getSymbolAtLocation(classDeclaration.name!));
  return classSymbol ? publicSurfaceFor(classSymbol, context.publicApi) : "unknown";
};

const collectClassMethodCandidate = (node: ts.Node, context: CandidateContext): void => {
  if (!ts.isMethodDeclaration(node) || !declarationNameText(node.name)) return;
  const classDeclaration = classForMember(node);
  if (!classDeclaration) return;
  addCandidate(context, {
    name: node.name,
    symbol: classMemberSymbol(node, classDeclaration, context.checker),
    kind: "method",
    displayName: `${classDeclaration.name!.text}.${declarationNameText(node.name)!}`,
    publicSurface: classMemberSurface(node, classDeclaration, context),
  });
};

const collectAccessorCandidate = (node: ts.Node, context: CandidateContext): void => {
  if ((!ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node)) || !declarationNameText(node.name)) return;
  const classDeclaration = classForMember(node);
  if (!classDeclaration) return;
  addCandidate(context, {
    name: node.name,
    symbol: classMemberSymbol(node, classDeclaration, context.checker),
    kind: "accessor",
    displayName: `${classDeclaration.name!.text}.${declarationNameText(node.name)!}`,
    publicSurface: classMemberSurface(node, classDeclaration, context),
  });
};

const classPropertyFunctionName = (node: ts.Node): ts.DeclarationName | undefined => {
  if (!ts.isPropertyDeclaration(node) || !declarationNameText(node.name)) return undefined;
  return node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? node.name : undefined;
};

const collectClassPropertyFunctionCandidate = (node: ts.Node, context: CandidateContext): void => {
  const name = classPropertyFunctionName(node);
  const classDeclaration = name && classForMember(node);
  if (!name || !classDeclaration || !ts.isPropertyDeclaration(node)) return;
  addCandidate(context, {
    name,
    symbol: classMemberSymbol(node, classDeclaration, context.checker),
    kind: "class-property-function",
    displayName: `${classDeclaration.name!.text}.${declarationNameText(name)!}`,
    publicSurface: classMemberSurface(node, classDeclaration, context),
  });
};

const objectPropertyFunctionName = (node: ts.Node): ts.Identifier | undefined => {
  if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name)) return undefined;
  return ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) ? node.name : undefined;
};

const collectObjectPropertyFunctionCandidate = (node: ts.Node, context: CandidateContext): void => {
  const name = objectPropertyFunctionName(node);
  if (name) addCandidate(context, { name, kind: "object-property-function", publicSurface: "unknown" });
};

const collectObjectMethodCandidate = (node: ts.Node, context: CandidateContext): void => {
  if (!ts.isMethodDeclaration(node) || !ts.isObjectLiteralExpression(node.parent) || !node.name || !ts.isIdentifier(node.name)) return;
  addCandidate(context, { name: node.name, kind: "object-property-function", publicSurface: "unknown" });
};

type CandidateCollector = (node: ts.Node, context: CandidateContext) => void;
const candidateCollectors: readonly CandidateCollector[] = [
  collectContractMemberCandidates,
  collectFunctionDeclarationCandidate,
  collectClassDeclarationCandidate,
  collectFunctionValueCandidate,
  collectClassMethodCandidate,
  collectAccessorCandidate,
  collectClassPropertyFunctionCandidate,
  collectObjectPropertyFunctionCandidate,
  collectObjectMethodCandidate,
];

export const collectCandidates = (
  sources: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  publicApi: ReadonlySet<ts.Symbol>,
  cwd: string,
): ReadonlyMap<string, PropertyCandidate> => {
  const candidates = new Map<string, PropertyCandidate>();
  for (const sourceFile of sources) {
    const context: CandidateContext = { candidates, checker, publicApi, cwd, sourceFile };
    const visit = (node: ts.Node): void => {
      for (const collector of candidateCollectors) collector(node, context);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return candidates;
};

const objectBindingPropertySymbol = (node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined => {
  const binding = ts.isBindingElement(node.parent) ? node.parent : undefined;
  if (!binding || !ts.isObjectBindingPattern(binding.parent) || (binding.name !== node && binding.propertyName !== node)) return undefined;
  const propertyName = binding.propertyName ?? binding.name;
  if (!ts.isIdentifier(propertyName) && !ts.isStringLiteral(propertyName) && !ts.isNumericLiteral(propertyName)) return undefined;
  return checker.getPropertyOfType(checker.getTypeAtLocation(binding.parent), propertyName.text);
};

const elementAccessPropertySymbol = (node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined => {
  if (!(ts.isStringLiteral(node) || ts.isNumericLiteral(node))
    || !ts.isElementAccessExpression(node.parent)
    || node.parent.argumentExpression !== node) return undefined;
  return checker.getPropertyOfType(checker.getTypeAtLocation(node.parent.expression), node.text);
};

const indexedAccessTypePropertySymbol = (node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined => {
  if (!(ts.isStringLiteral(node) || ts.isNumericLiteral(node))
    || !ts.isLiteralTypeNode(node.parent)
    || !ts.isIndexedAccessTypeNode(node.parent.parent)
    || node.parent.parent.indexType !== node.parent) return undefined;
  return checker.getPropertyOfType(checker.getTypeFromTypeNode(node.parent.parent.objectType), node.text);
};

const referenceSymbolAt = (node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined => {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return objectBindingPropertySymbol(node, checker) ?? checker.getSymbolAtLocation(node);
  // Literal value/type indexing is compiler-resolved to a property symbol;
  // non-literal access remains intentionally outside direct-reference evidence.
  return elementAccessPropertySymbol(node, checker) ?? indexedAccessTypePropertySymbol(node, checker);
};

export const collectReferences = (
  sources: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  candidates: ReadonlyMap<string, PropertyCandidate>,
  cwd: string,
): ReadonlyMap<string, readonly SymbolReference[]> => {
  const references = new Map<string, SymbolReference[]>();
  for (const identity of candidates.keys()) references.set(identity, []);
  for (const sourceFile of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
        const symbol = aliasTypeScriptSymbol(checker, referenceSymbolAt(node, checker));
        const identity = symbol && symbolIdentity(symbol, cwd);
        if (symbol && identity && candidates.has(identity) && !isDeclarationIdentifier(node, symbol)) {
          references.get(identity)?.push({ file: relativeTypeScriptPath(cwd, sourceFile.fileName), line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return new Map([...references].map(([symbol, values]) => [
    symbol,
    [...new Map(values.map((reference) => [`${reference.file}:${reference.line}`, reference])).values()]
      .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line),
  ]));
};
