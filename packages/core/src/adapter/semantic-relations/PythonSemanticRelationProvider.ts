import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { ParserService, QueryCapture, QueryMatch } from "../../port/ParserService";
import type { LspLaunchSpec, LspSession } from "../lsp/NodeLspSession";
import { startNodeLspSession } from "../lsp/NodeLspSession";
import { pyrightWorkspaceRisks } from "../symbol-use/PyrightWorkspaceScope";
import { listProjectSourceFiles } from "../../projectFiles";
import type { SemanticRelationProvider, SemanticRelationRequest } from "../../semantic-relations/provider";
import type { SemanticRelationFact, SemanticRelationReport, SemanticRelationSymbol } from "../../semantic-relations/types";

const DIAGNOSTIC_READINESS_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_INDEX_TIMEOUT_MS ?? 180_000);
const LSP_REQUEST_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_REQUEST_TIMEOUT_MS ?? 120_000);

interface ClassDeclaration {
  readonly file: string;
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startIndex: number;
}

interface RelationCandidate {
  readonly kind: SemanticRelationFact["kind"];
  readonly file: string;
  readonly line: number;
  readonly typeRef: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly source?: ClassDeclaration;
}

export interface PythonSemanticRelationRuntime {
  readonly parser?: ParserService;
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly startSession?: (launch: LspLaunchSpec, cwd: string) => LspSession | Promise<LspSession>;
}

const CLASS_QUERY = "(class_definition name: (identifier) @name body: (block) @body)";
const BASE_QUERY = `[
  (class_definition name: (identifier) @className superclasses: (argument_list (identifier) @typeRef))
  (class_definition name: (identifier) @className superclasses: (argument_list (attribute attribute: (identifier) @typeRef)))
]`;
const PARAMETER_QUERY = "(function_definition parameters: (parameters (typed_parameter type: (type) @typeRef)))";
const RETURN_QUERY = "(function_definition return_type: (type) @typeRef)";
const FIELD_QUERY = "(expression_statement (assignment left: (identifier) @fieldName type: (type) @typeRef))";
const INSTANTIATE_QUERY = `[
  (call function: (identifier) @typeRef)
  (call function: (attribute attribute: (identifier) @typeRef))
]`;

const captureOf = (match: QueryMatch, name: string): QueryCapture | undefined =>
  match.captures.find((capture) => capture.name === name);

const lastIdentifierOffset = (source: string, startIndex: number, endIndex: number): number => {
  const slice = source.slice(startIndex, endIndex);
  const match = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(slice);
  return match ? startIndex + match.index : startIndex;
};

const positionForOffset = (source: string, offset: number): { readonly line: number; readonly character: number } => {
  const prefix = source.slice(0, offset);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  return { line: prefix.slice(0, lineStart).split("\n").length - 1, character: offset - lineStart };
};

const repositoryPath = (cwd: string, uri: string): string | undefined => {
  try {
    const path = fileURLToPath(uri);
    const fromRoot = relative(resolve(cwd), resolve(path));
    return fromRoot === "" || (!fromRoot.startsWith("..") && !fromRoot.includes("../"))
      ? relative(cwd, path).replace(/\\/g, "/")
      : undefined;
  } catch {
    return undefined;
  }
};

const classDeclarations = async (
  parser: ParserService,
  files: readonly string[],
): Promise<readonly ClassDeclaration[]> => {
  const declarations: ClassDeclaration[] = [];
  for (const file of files) {
    const matches = await Effect.runPromise(parser.query(file, CLASS_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))));
    for (const match of matches) {
      const name = captureOf(match, "name");
      const body = captureOf(match, "body");
      if (!name || name.startLine === undefined || name.startIndex === undefined) continue;
      declarations.push({
        file,
        name: name.text,
        startLine: name.startLine,
        endLine: body?.endLine ?? name.endLine ?? name.startLine,
        startIndex: name.startIndex,
      });
    }
  }
  return declarations;
};

const enclosingClass = (declarations: readonly ClassDeclaration[], file: string, line: number): ClassDeclaration | undefined =>
  declarations.find((declaration) => declaration.file === file && line >= declaration.startLine && line <= declaration.endLine);

const relativeFile = (cwd: string, file: string): string => relative(cwd, file).replace(/\\/g, "/");

const classSymbol = (declaration: ClassDeclaration, file: string): SemanticRelationSymbol => ({
  id: `python:repository:${file}:${declaration.name}`,
  name: declaration.name,
  kind: "class",
  scope: "repository",
  file,
  line: declaration.startLine,
});

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

const definitionLocations = (value: unknown): readonly { readonly file: string; readonly line: number }[] => {
  const locations = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return locations.flatMap((entry): { file: string; line: number }[] => {
    if (!entry || typeof entry !== "object") return [];
    const location = entry as { uri?: unknown; range?: { start?: { line?: unknown } } };
    return typeof location.uri === "string" && typeof location.range?.start?.line === "number"
      ? [{ file: location.uri, line: location.range.start.line + 1 }]
      : [];
  });
};

const resolveTarget = (
  cwd: string,
  declarations: readonly ClassDeclaration[],
  uri: string,
  line: number,
): { readonly declaration: ClassDeclaration; readonly file: string } | undefined => {
  const file = repositoryPath(cwd, uri);
  if (!file) return undefined;
  const absolute = resolve(cwd, file);
  const exact = declarations.find((declaration) => declaration.file === absolute && declaration.startLine === line);
  const byRange = exact ?? declarations.find((declaration) => declaration.file === absolute && line >= declaration.startLine && line <= declaration.endLine);
  return byRange ? { declaration: byRange, file } : undefined;
};

const pythonLaunch = (executable: string): LspLaunchSpec =>
  executable.toLowerCase().endsWith(".js")
    ? { command: process.env.OPENARCH_NODE ?? "node", args: [executable, "--stdio"] }
    : { command: executable, args: [] };

const supportsDefinitions = (capability: boolean | Record<string, unknown> | undefined): boolean =>
  capability === true || (typeof capability === "object" && capability !== null);

const initializeWorkspace = async (session: LspSession, cwd: string): Promise<void> => {
  const rootUri = pathToFileURL(resolve(cwd)).href;
  const initialized = await session.request<{ capabilities?: { definitionProvider?: boolean | Record<string, unknown> } }>("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: resolve(cwd).split(/[\\/]/).pop() ?? "workspace" }],
    capabilities: {
      workspace: { configuration: true, workspaceFolders: true },
      textDocument: { definition: { dynamicRegistration: false } },
    },
  }, 15_000);
  if (!supportsDefinitions(initialized.capabilities?.definitionProvider)) {
    throw new Error("LSP server did not advertise textDocument/definition support");
  }
  session.notify("initialized", {});
};

const unavailable = (reason: string): SemanticRelationReport => ({
  origin: { language: "python", providerId: "python-pyright-semantic-relations", evidenceSource: "lsp" },
  state: { availability: "unavailable", coverage: { symbols: "unavailable", relations: "unavailable" }, reason },
  facts: [],
});

export const collectPythonSemanticRelations = (
  input: SemanticRelationRequest,
  runtime: PythonSemanticRelationRuntime,
): Effect.Effect<SemanticRelationReport, never> =>
  Effect.gen(function* () {
    const parser = runtime.parser;
    const executable = runtime.executable;
    if (!parser) return unavailable("ParserService is unavailable");
    if (!executable) return unavailable("pyright executable is unavailable; configure the python toolchain");
    const files = listProjectSourceFiles({ cwd: input.cwd, languages: ["python"], population: "production-governance" });
    if (files.length === 0) return unavailable("no governed Python source files");

    const declarations = yield* Effect.promise(() => classDeclarations(parser, files));
    const sources = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
    const classNames = new Set(declarations.map((declaration) => declaration.name));

    const candidates: RelationCandidate[] = [];
    const pushMatches = (
      file: string,
      matches: readonly QueryMatch[],
      kind: SemanticRelationFact["kind"],
      sourceOf: (match: QueryMatch) => ClassDeclaration | undefined,
    ): void => {
      for (const match of matches) {
        const typeRef = captureOf(match, "typeRef");
        if (!typeRef || typeRef.startIndex === undefined || typeRef.endIndex === undefined || typeRef.startLine === undefined) continue;
        if (kind === "instantiates" && !classNames.has(typeRef.text)) continue;
        const source = sourceOf(match);
        if (kind !== "extends" && !source) continue;
        candidates.push({
          kind, file,
          line: typeRef.startLine,
          typeRef: typeRef.text,
          startIndex: lastIdentifierOffset(sources.get(file)!, typeRef.startIndex, typeRef.endIndex),
          endIndex: typeRef.endIndex,
          ...(source ? { source } : {}),
        });
      }
    };

    for (const file of files) {
      const classDecls = declarations.filter((declaration) => declaration.file === file);
      const sourceForName = (name: string): ClassDeclaration | undefined => classDecls.find((declaration) => declaration.name === name);
      const enclosing = (line: number): ClassDeclaration | undefined => enclosingClass(classDecls, file, line);
      const [bases, parameters, returns, fields, instantiates] = yield* Effect.all([
        parser.query(file, BASE_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
        parser.query(file, PARAMETER_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
        parser.query(file, RETURN_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
        parser.query(file, FIELD_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
        parser.query(file, INSTANTIATE_QUERY).pipe(Effect.catchAll(() => Effect.succeed([]))),
      ]);
      pushMatches(file, bases, "extends", (match) => {
        const name = captureOf(match, "className")?.text;
        return name ? sourceForName(name) : undefined;
      });
      pushMatches(file, parameters, "parameter_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
      pushMatches(file, returns, "return_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
      pushMatches(file, fields, "field_type", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
      pushMatches(file, instantiates, "instantiates", (match) => enclosing(captureOf(match, "typeRef")?.startLine ?? -1));
    }

    return yield* Effect.promise(async (): Promise<SemanticRelationReport> => {
      const launch = pythonLaunch(executable);
      let session: LspSession;
      try {
        session = await (runtime.startSession ?? startNodeLspSession)(launch, input.cwd);
      } catch (error) {
        return unavailable(`failed to start pyright: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        try {
          await initializeWorkspace(session, input.cwd);
        } catch (error) {
          return unavailable(`failed to initialize pyright: ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const file of files) {
          session.notify("textDocument/didOpen", {
            textDocument: { uri: pathToFileURL(file).href, languageId: "python", version: 1, text: sources.get(file)! },
          });
        }
        // Pyright indexes opened files on documentSymbol requests; this mirrors
        // the symbol-use warmup so diagnostics readiness observes a real index.
        let warmupIncomplete = false;
        for (const file of files) {
          try {
            await session.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(file).href } }, LSP_REQUEST_TIMEOUT_MS);
          } catch {
            warmupIncomplete = true;
          }
        }
        const uris = files.map((file) => pathToFileURL(file).href);
        const diagnosticsReady = session.waitForDiagnostics
          ? await session.waitForDiagnostics(uris, DIAGNOSTIC_READINESS_TIMEOUT_MS).catch(() => false)
          : true;

        const risks = pyrightWorkspaceRisks({ cwd: input.cwd });
        let resolved = 0;
        let unresolved = 0;
        let targetCount = 0;
        const facts: SemanticRelationFact[] = [];
        for (const candidate of candidates) {
          if (!candidate.source) continue;
          const position = positionForOffset(sources.get(candidate.file)!, candidate.startIndex);
          let targets: readonly { readonly declaration: ClassDeclaration; readonly file: string }[] = [];
          try {
            const response = await session.request("textDocument/definition", {
              textDocument: { uri: pathToFileURL(candidate.file).href },
              position,
            }, LSP_REQUEST_TIMEOUT_MS);
            resolved += 1;
            targets = definitionLocations(response).flatMap(({ file: uri, line }) => {
              const target = resolveTarget(input.cwd, declarations, uri, line);
              return target ? [target] : [];
            });
            targetCount += targets.length;
          } catch {
            unresolved += 1;
          }
          const sourceFile = relativeFile(input.cwd, candidate.file);
          const source = classSymbol(candidate.source, sourceFile);
          for (const target of targets) {
            facts.push({
              language: "python",
              kind: candidate.kind,
              source,
              target: classSymbol(target.declaration, target.file),
              direct: true,
              evidence: { file: sourceFile, line: candidate.line },
            });
          }
        }

        // Pyright may not publish diagnostics for every opened URI, so diagnostic
        // readiness is only a gate for an empty candidate set. With candidates,
        // all definition requests must succeed and at least one target resolve.
        const requestComplete = candidates.length === 0
          ? diagnosticsReady
          : unresolved === 0 && resolved === candidates.length && targetCount > 0;
        const complete = requestComplete && !warmupIncomplete && risks.length === 0;
        return {
          origin: { language: "python", providerId: "python-pyright-semantic-relations", evidenceSource: "lsp" },
          state: {
            availability: complete ? "available" : "partial",
            coverage: {
              symbols: complete ? "complete" : "partial",
              relations: complete ? "complete" : "partial",
            },
            ...(complete ? {} : { reason: [
              ...(candidates.length === 0 && !diagnosticsReady ? ["pyright diagnostics readiness did not complete"] : []),
              ...(warmupIncomplete ? ["some documentSymbol warmup requests failed"] : []),
              ...(risks.length > 0 ? risks : []),
              ...(unresolved > 0 ? [`${unresolved} definition requests failed`] : []),
              ...(candidates.length > 0 && resolved > 0 && targetCount === 0 ? ["no candidate definition resolved to a repository target"] : []),
            ].join("; ") }),
          },
          facts: uniqueFacts(facts),
        };
      } finally {
        await Promise.resolve(session.close());
      }
    });
  });

export const pythonSemanticRelationProvider: SemanticRelationProvider = {
  id: "python-pyright-semantic-relations",
  evidenceSource: "lsp",
  languages: ["python"],
  requiredToolchains: ["pyright"],
  collect: (input, context) => collectPythonSemanticRelations(input, {
    parser: context.parser,
    executable: context.toolchains.get("pyright")?.executable,
  }),
};
