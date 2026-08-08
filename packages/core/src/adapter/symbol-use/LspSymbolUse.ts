import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import type { Language } from "../../domain/ast";
import type { QueryCapture, QueryMatch, ParserService } from "../../port/ParserService";
import type { SymbolUseRequest } from "../../port/SymbolUseService";
import { symbolUseScopeFor, type SymbolReference, type SymbolUseFact, type SymbolUseReport } from "../../symbol-use/types";
import { selectSymbolUseDemand } from "../../symbol-use/demand";
import { listProjectSourceFiles } from "../../projectFiles";
import { lspLaunchSpec, startNodeLspSession, type LspLaunchSpec, type LspSession } from "../lsp/NodeLspSession";
import { selectByKeyWaves, selectSupportingFiles } from "./LspRequestSelection";

const MAX_REFERENCE_REQUESTS = 200;
const MAX_DOCUMENT_REQUESTS = 500;
const REQUEST_CONCURRENCY = 8;

/** LSP 请求级调试日志（OPENARCH_LSP_DEBUG=1）——独立 helper 避免推高主函数分支复杂度。 */
const lspDebug = (message: string): void => {
  if (process.env.OPENARCH_LSP_DEBUG === "1") console.error(message);
};
const DIAGNOSTIC_READINESS_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_INDEX_TIMEOUT_MS ?? 180_000);
const LSP_REQUEST_TIMEOUT_MS = Number(process.env.OPENARCH_LSP_REQUEST_TIMEOUT_MS ?? 120_000);

export interface LspDeclarationQuery {
  readonly kind: SymbolUseFact["declaration"]["kind"];
  readonly pattern: string;
}

export interface LspCoverageRisk {
  readonly pattern: string;
  readonly reason: string;
  readonly detected: (matches: readonly QueryMatch[]) => boolean;
}

export interface LspSourceRisk {
  readonly reason: string;
  readonly detected: (source: string) => boolean;
}

export interface LspWorkspaceScope {
  /**
   * A language provider may promise complete references only for a bounded
   * workspace shape. These checks are evidence of an unsupported shape, not
   * a reason to skip useful report-only LSP facts.
   */
  readonly declarationRisks?: (context: { readonly cwd: string; readonly files: readonly string[] }) => readonly string[];
  readonly repositoryReferenceRisks?: (context: { readonly cwd: string; readonly files: readonly string[] }) => readonly string[];
}

export interface LspSymbolUseDefinition {
  readonly language: Exclude<Language, "typescript" | "javascript">;
  readonly providerId: string;
  readonly languageId: string;
  readonly declarationQueries: readonly LspDeclarationQuery[];
  /**
   * 候选声明 references 查询的最大并发（默认 REQUEST_CONCURRENCY=8）。
   * JDT（jdtls）的 LSP 请求单线程串行处理，并发 references 会排队超时
   * （校准 2026-08-06：重载族 2 个候选并发查询，第二个 60s 超时返回空）——
   * Java 设 1 串行。
   */
  readonly candidateConcurrency?: number;
  /** Classifies a candidate as internal or declared-public after it is accepted. */
  readonly isInternal: (name: string, source: string, startIndex: number) => boolean;
  /** Excludes declarations whose language runtime semantics cannot support this fact family. */
  readonly isCandidate?: (name: string, source: string, startIndex: number) => boolean;
  /** Exact server invocation is a language protocol fact, never inferred by the transport. */
  readonly launch?: (executable: string, cwd: string) => LspLaunchSpec;
  /** Until a real workspace calibration exists, facts remain useful report-only evidence. */
  readonly coverageCeilingReason?: string;
  readonly coverageRisks?: readonly LspCoverageRisk[];
  /** Source-level constructs that invalidate whole-scope reference completeness. */
  readonly sourceRisks?: readonly LspSourceRisk[];
  /** Workspace topology constraints for a calibrated complete-reference scope. */
  readonly workspaceScope?: LspWorkspaceScope;
  /** Standard diagnostic publication is the provider's calibrated workspace-ready evidence. */
  readonly requiresDiagnosticReadiness?: boolean;
  /**
   * Index-ready probe: LSP publishDiagnostics arrives before the full
   * find-references crate/workspace index is usable (calibration 2026-08-06:
   * rust-analyzer returns empty references even though diagnostics were
   * published). Providers that set this poll workspace/symbol for the first
   * candidate declaration until the symbol appears (index ready) or the
   * timeout expires, then run references.
   */
  readonly indexReady?: {
    readonly pollMs?: number;
    readonly timeoutMs?: number;
  };
}

export interface LspSymbolUseRuntime {
  readonly parser?: ParserService;
  readonly executable?: string;
  /** Provider-specific server environment; never persisted in governed-project configuration. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly startSession?: (launch: LspLaunchSpec, cwd: string) => LspSession | Promise<LspSession>;
}

interface Candidate {
  readonly file: string;
  readonly name: string;
  readonly kind: LspDeclarationQuery["kind"];
  readonly line: number;
  readonly startIndex: number;
  readonly publicSurface: SymbolUseFact["publicSurface"];
}

interface Collection {
  readonly candidates: readonly Candidate[];
  readonly incomplete: boolean;
  readonly riskReasons: readonly string[];
}

interface LspInitializeResult {
  readonly capabilities?: {
    /** LSP permits either an enabled boolean or a provider options object. */
    readonly referencesProvider?: boolean | Record<string, unknown>;
    readonly workspaceSymbolProvider?: boolean | Record<string, unknown>;
  };
}

interface LspPosition {
  readonly line: number;
  readonly character: number;
}

interface LspLocation {
  readonly uri: string;
  readonly range: { readonly start: LspPosition };
}

const supportsReferences = (capability: boolean | Record<string, unknown> | undefined): boolean =>
  capability === true || (typeof capability === "object" && capability !== null);

const unavailable = (definition: LspSymbolUseDefinition, reason: string): SymbolUseReport => ({
  origin: { language: definition.language, providerId: definition.providerId, evidenceSource: "lsp" },
  state: { availability: "unavailable", coverage: { declarations: "unavailable", repositoryReferences: "unavailable" }, reason },
  facts: [],
});

/** LSP servers compare workspace URI paths byte-for-byte; normalize Windows short names before opening documents. */
const canonicalWorkspace = (cwd: string): string => {
  try { return realpathSync.native(cwd); } catch { return cwd; }
};

const positionForSourceOffset = (source: string, sourceOffset: number): LspPosition | undefined => {
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0 || sourceOffset > source.length) return undefined;
  const prefix = source.slice(0, sourceOffset);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  return { line: prefix.slice(0, lineStart).split("\n").length - 1, character: prefix.length - lineStart };
};

const relativeFileFromUri = (cwd: string, uri: string): string | undefined => {
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

const referencesFor = (cwd: string, locations: unknown): readonly SymbolReference[] | undefined => {
  if (!Array.isArray(locations)) return locations === null ? [] : undefined;
  const references = locations.flatMap((location): SymbolReference[] => {
    const candidate = location as Partial<LspLocation>;
    const file = typeof candidate.uri === "string" ? relativeFileFromUri(cwd, candidate.uri) : undefined;
    const line = candidate.range?.start?.line;
    return file && typeof line === "number" && Number.isSafeInteger(line) && line >= 0 ? [{ file, line: line + 1 }] : [];
  });
  return [...new Map(references.map((reference) => [`${reference.file}:${reference.line}`, reference])).values()]
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
};

const mapWithConcurrency = async <Input, Output>(
  items: readonly Input[],
  work: (item: Input) => Promise<Output>,
  concurrency = REQUEST_CONCURRENCY,
): Promise<readonly Output[]> => {
  const results: Output[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) results.push(await work(item));
    }
  }));
  return results;
};

const candidatesForQuery = (
  file: string,
  source: string,
  query: LspDeclarationQuery,
  matches: readonly QueryMatch[],
  definition: LspSymbolUseDefinition,
  demandedNames?: ReadonlySet<string>,
): readonly Candidate[] => matches.flatMap((match) => {
  const capture: QueryCapture | undefined = match.captures.find((item) => item.name === "name");
  if (!capture || capture.startLine === undefined || capture.startIndex === undefined) return [];
  if (definition.isCandidate && !definition.isCandidate(capture.text, source, capture.startIndex)) return [];
  // 空 demandedNames = 文件级兜底（--change-override 的 manual:file 变更无符号名，
  // 校准 2026-08-06）——不按名字过滤，查询该文件全部（公共）声明；否则空 set
  // 过滤掉所有候选，references 永不查询（0 确认）。
  if (demandedNames && demandedNames.size > 0 && !demandedNames.has(capture.text)) return [];
  return [{
    file,
    name: capture.text,
    kind: query.kind,
    line: capture.startLine,
    startIndex: capture.startIndex,
    publicSurface: definition.isInternal(capture.text, source, capture.startIndex) ? "internal" : "declared-public",
  }];
});

const collectDeclarations = (
  parser: ParserService,
  files: readonly string[],
  definition: LspSymbolUseDefinition,
  namesByFile?: ReadonlyMap<string, ReadonlySet<string>>,
) =>
  Effect.forEach(files, (file) => Effect.try({
    try: () => readFileSync(file, "utf8"),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((source) => Effect.all({
      declarations: Effect.all(definition.declarationQueries.map((query) => parser.query(file, query.pattern).pipe(
        Effect.map((matches) => candidatesForQuery(file, source, query, matches, definition, namesByFile?.get(file))),
      )), { concurrency: 1 }),
      risks: Effect.all((definition.coverageRisks ?? []).map((risk) => parser.query(file, risk.pattern).pipe(
        Effect.map((matches) => risk.detected(matches) ? risk.reason : undefined),
      )).concat((definition.sourceRisks ?? []).map((risk) =>
        Effect.succeed(risk.detected(source) ? risk.reason : undefined),
      )), { concurrency: 1 }),
    }, { concurrency: 1 }).pipe(
      Effect.map(({ declarations, risks }) => ({
        candidates: declarations.flat(), incomplete: false, riskReasons: risks.filter((reason): reason is string => Boolean(reason)),
      } satisfies Collection)),
    )),
    Effect.catchAll(() => Effect.succeed({ candidates: [], incomplete: true, riskReasons: [] } satisfies Collection)),
  ), { concurrency: 1 });

const openAndPrepareDocuments = async (
  session: LspSession,
  files: readonly string[],
  languageId: string,
): Promise<{ readonly sources: ReadonlyMap<string, string>; readonly incomplete: boolean }> => {
  const sources = new Map<string, string>();
  let incomplete = false;
  lspDebug(`[lsp] openAndPrepare files=${files.length}`);
  for (const file of files) {
    lspDebug(`[lsp] open ${file}`);
    try {
      const source = readFileSync(file, "utf8");
      sources.set(file, source);
      session.notify("textDocument/didOpen", { textDocument: { uri: pathToFileURL(file).href, languageId, version: 1, text: source } });
    } catch {
      incomplete = true;
    }
  }
  await mapWithConcurrency([...sources.keys()], async (file) => {
    try {
      await session.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(file).href } }, LSP_REQUEST_TIMEOUT_MS);
    } catch {
      incomplete = true;
    }
  }, 1);
  return { sources, incomplete };
};

const initializeWorkspace = async (session: LspSession, cwd: string): Promise<LspInitializeResult> => {
  const rootUri = pathToFileURL(resolve(cwd)).href;
  const initialized = await session.request<LspInitializeResult>("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: basename(resolve(cwd)) }],
    capabilities: {
      workspace: { configuration: true, workspaceFolders: true },
      window: { workDoneProgress: true },
      textDocument: { references: { dynamicRegistration: false } },
    },
  }, 15_000);
  if (!supportsReferences(initialized.capabilities?.referencesProvider)) {
    throw new Error("LSP server did not advertise textDocument/references support");
  }
  session.notify("initialized", {});
  return initialized;
};

const factForCandidate = async (
  session: LspSession,
  cwd: string,
  definition: LspSymbolUseDefinition,
  candidate: Candidate,
  source: string,
): Promise<SymbolUseFact | undefined> => {
  const position = positionForSourceOffset(source, candidate.startIndex);
  if (!position) return undefined;
  const locations = await session.request<unknown>("textDocument/references", {
    textDocument: { uri: pathToFileURL(candidate.file).href }, position, context: { includeDeclaration: false },
  }, LSP_REQUEST_TIMEOUT_MS);
  const repositoryReferences = referencesFor(cwd, locations);
  if (!repositoryReferences) return undefined;
  return {
    language: definition.language,
    declaration: { file: relative(cwd, candidate.file).replace(/\\/g, "/"), name: candidate.name, kind: candidate.kind, line: candidate.line },
    repositoryReferences,
    publicSurface: candidate.publicSurface,
  };
};

/**
 * 索引就绪轮询（校准 2026-08-06）：rust-analyzer 的 publishDiagnostics 先于
 * find-references 的完整 crate 索引到达，直接 references 会返回空。轮询
 * workspace/symbol（query=首个候选声明名）直到符号出现（索引就绪）或超时。
 * 超时不算失败（返回 false 由调用方标记 incomplete），避免把慢索引误判为
 * 服务不可用。
 */
const probeIndexReady = async (
  session: LspSession,
  candidates: readonly Candidate[],
  pollMs: number,
  timeoutMs: number,
): Promise<boolean> => {
  const probeName = candidates[0]?.name;
  const probeFile = candidates[0]?.file;
  // 精确到文件：query 太泛（如方法名 "new"）会提前命中其他 crate 的符号，
  // 但 references 仍需声明文件本身被索引（校准 2026-08-06：假就绪导致空引用）。
  // realpath 归一：Windows 8.3 短路径（ADMINI~1）与长路径（Administrator）的
  // file URI 不一致，直接比较会永不命中。
  const probeUri = probeFile ? pathToFileURL(realpathSync.native(probeFile)).href : undefined;
  if (!probeName || !session.request) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const symbols = await session.request<readonly { name?: string; location?: { uri?: string } }[]>("workspace/symbol", { query: probeName }, Math.min(30_000, deadline - Date.now()));
      const ready = (symbols ?? []).some((symbol) =>
        symbol.name === probeName && (!probeUri || symbol.location?.uri === probeUri));
      if (ready) return true;
    } catch {
      return true; // 服务不支持 workspace/symbol 或查询失败——不阻塞 references
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};

const collectReferences = async (
  cwd: string,
  files: readonly string[],
  candidates: readonly Candidate[],
  definition: LspSymbolUseDefinition,
  runtime: Required<Pick<LspSymbolUseRuntime, "executable">> & LspSymbolUseRuntime,
  demandDriven: boolean,
  waitForDiagnostics: boolean,
): Promise<{ readonly facts: readonly SymbolUseFact[]; readonly incomplete: boolean }> => {
  const baseLaunch = (definition.launch ?? ((executable) => lspLaunchSpec(executable)))(runtime.executable, cwd);
  const launch = runtime.environment ? { ...baseLaunch, environment: runtime.environment } : baseLaunch;
  lspDebug(`[lsp] collectReferences files=${files.length} candidates=${candidates.length}`);
  const session = await (runtime.startSession ?? startNodeLspSession)(launch, cwd);
  let incomplete = false;
  try {
    await initializeWorkspace(session, cwd);
    lspDebug(`[lsp] workspace initialized`);
    const prepared = await openAndPrepareDocuments(session, files, definition.languageId);
    lspDebug(`[lsp] documents prepared sources=${prepared.sources.size}`);
    // Languages that require diagnostic readiness (e.g. gopls references need
    // the full workspace index; measured ~70s cold for a 162-file module) must
    // wait for the index even on a demand-driven run - skipping it makes every
    // references query fail its timeout and report incomplete. Non-demand runs
    // and --wait-index always wait; demand runs without the flag skip the wait
    // for languages that do not require it.
    const waitIndex = !demandDriven || waitForDiagnostics || definition.requiresDiagnosticReadiness;
    const diagnosticsReady = definition.requiresDiagnosticReadiness && session.waitForDiagnostics && waitIndex
      ? await session.waitForDiagnostics([...prepared.sources.keys()].map((file) => pathToFileURL(file).href), DIAGNOSTIC_READINESS_TIMEOUT_MS)
      : true;
    // diagnostics 先于 find-references 的完整索引到达（校准 2026-08-06：rust-analyzer）。
    // indexReady 配置时，用 workspace/symbol 轮询候选声明作为索引就绪信号，再跑 references。
    const indexReady = definition.indexReady && waitIndex
      ? await probeIndexReady(session, candidates, definition.indexReady.pollMs ?? 5_000, definition.indexReady.timeoutMs ?? 180_000)
      : true;
    incomplete = prepared.incomplete || !diagnosticsReady || !indexReady;
    const facts = await mapWithConcurrency(candidates, async (candidate) => {
      const source = prepared.sources.get(candidate.file);
      if (!source) { incomplete = true; return undefined; }
      try { return await factForCandidate(session, cwd, definition, candidate, source); } catch { incomplete = true; return undefined; }
    }, definition.candidateConcurrency);
    return {
      facts: facts.filter((fact): fact is SymbolUseFact => Boolean(fact)).sort((left, right) =>
        left.declaration.file.localeCompare(right.declaration.file)
        || left.declaration.line - right.declaration.line
        || left.declaration.name.localeCompare(right.declaration.name)),
      incomplete,
    };
  } finally {
    try { session.notify("exit", {}); } catch { /* Transport may already have failed. */ }
    await session.close();
  }
};

/** Shared bounded LSP workflow; language adapters contribute syntax and protocol facts only. */
export const collectLspSymbolUse = (
  input: SymbolUseRequest,
  runtime: LspSymbolUseRuntime,
  definition: LspSymbolUseDefinition,
): Effect.Effect<SymbolUseReport> => {
  if (!runtime.parser) return Effect.succeed(unavailable(definition, "ParserService is required to anchor declarations"));
  if (!runtime.executable) return Effect.succeed(unavailable(definition, `global ${definition.providerId} executable is unavailable`));
  const cwd = canonicalWorkspace(input.cwd);
  const files = listProjectSourceFiles({ cwd, languages: [definition.language], population: "production-governance" });
  const demand = selectSymbolUseDemand(cwd, files, input.demand);
  const workspaceDeclarationRisks = definition.workspaceScope?.declarationRisks?.({ cwd, files }) ?? [];
  const workspaceReferenceRisks = definition.workspaceScope?.repositoryReferenceRisks?.({ cwd, files }) ?? [];
  return collectDeclarations(runtime.parser, demand.declarationFiles, definition, demand.namesByFile).pipe(
    Effect.flatMap((collections) => {
      const candidates = collections.flatMap((collection) => collection.candidates);
      const selectedCandidates = selectByKeyWaves(candidates, MAX_REFERENCE_REQUESTS, (candidate) => candidate.file);
      // Demand mode still didOpens the static consumer candidates (warm the
      // LSP index so cross-package references are confirmed - calibration
      // 2026-08-05: gopls demand without consumerFiles confirmed 0/15
      // production callers). Declarations and reference queries stay limited
      // to the changed files, so the demand budget savings are preserved.
      const referenceFiles: readonly string[] = input.demand
        ? [...new Set([...selectedCandidates.map((candidate) => candidate.file), ...(input.demand.consumerFiles ?? [])])].sort()
        : selectSupportingFiles(files, selectedCandidates.map((candidate) => candidate.file), MAX_DOCUMENT_REQUESTS);
      const declarationIncomplete = collections.some((collection) => collection.incomplete);
      const riskReasons = [...new Set(collections.flatMap((collection) => collection.riskReasons))];
      const bounded = candidates.length > MAX_REFERENCE_REQUESTS;
      const documentBounded = files.length > MAX_DOCUMENT_REQUESTS;
      return Effect.tryPromise({
        try: () => collectReferences(cwd, referenceFiles, selectedCandidates, definition, runtime as Required<Pick<LspSymbolUseRuntime, "executable">> & LspSymbolUseRuntime, Boolean(input.demand), input.waitForDiagnostics === true),
        catch: (error) => error,
      }).pipe(
        Effect.map((references) => {
          const declarationReasons = [
            ...workspaceDeclarationRisks,
            demand.reason,
            ...riskReasons,
            declarationIncomplete ? "parser declaration collection is incomplete" : undefined,
          ].filter((reason): reason is string => Boolean(reason));
          const referenceReasons = [
            definition.coverageCeilingReason,
            ...workspaceReferenceRisks,
            ...declarationReasons,
            documentBounded ? `document analysis request budget reached (${MAX_DOCUMENT_REQUESTS})` : undefined,
            bounded ? `reference request budget reached (${MAX_REFERENCE_REQUESTS})` : undefined,
            references.incomplete ? "LSP document or reference collection is incomplete" : undefined,
          ].filter((reason): reason is string => Boolean(reason));
          const declarationsCoverage = declarationReasons.length === 0 ? "complete" as const : "partial" as const;
          const repositoryReferencesCoverage = referenceReasons.length === 0 ? "complete" as const : "partial" as const;
          const reasons = [...new Set([...declarationReasons, ...referenceReasons])];
          return {
            origin: { language: definition.language, providerId: definition.providerId, evidenceSource: "lsp" },
            state: {
              availability: declarationsCoverage === "complete" && repositoryReferencesCoverage === "complete" ? "available" : "partial",
              coverage: { declarations: declarationsCoverage, repositoryReferences: repositoryReferencesCoverage, incompleteReferences: references.incomplete },
              ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
            },
            scope: symbolUseScopeFor(input.demand ? "demand" : "repository", files.length, demand.declarationFiles.length, definition.declarationQueries.map((query) => query.kind)),
            facts: references.facts,
          } satisfies SymbolUseReport;
        }),
        Effect.catchAll((error) => Effect.succeed(unavailable(definition, error instanceof Error ? error.message : String(error)))),
      );
    }),
  );
};
