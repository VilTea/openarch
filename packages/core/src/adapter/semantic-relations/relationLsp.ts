import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspLaunchSpec, LspSession } from "../lsp/NodeLspSession";
import { startNodeLspSession } from "../lsp/NodeLspSession";

export interface RelationLspRuntime {
  readonly startSession?: (launch: LspLaunchSpec, cwd: string) => LspSession | Promise<LspSession>;
}

export const defaultRelationStartSession = (launch: LspLaunchSpec, cwd: string): LspSession => startNodeLspSession(launch, cwd);

/** Node-based language servers whose npm entry is a plain .js file need the explicit
 *  node invocation used by the Python provider; native executables stay direct. */
export const relationLaunchForNodeEntry = (executable: string): LspLaunchSpec =>
  executable.toLowerCase().endsWith(".js")
    ? { command: process.env.OPENARCH_NODE ?? "node", args: [executable, "--stdio"] }
    : { command: executable, args: [] };

export const relationLaunch = (executable: string, args: readonly string[] = []): LspLaunchSpec =>
  ({ command: executable, args: [...args] });

const supportsCapability = (capability: boolean | Record<string, unknown> | undefined): boolean =>
  capability === true || (typeof capability === "object" && capability !== null);

export const initializeRelationWorkspace = async (
  session: LspSession,
  cwd: string,
  capability: keyof { definitionProvider?: unknown },
): Promise<void> => {
  const rootUri = pathToFileURL(resolve(cwd)).href;
  const initialized = await session.request<{ capabilities?: Record<string, boolean | Record<string, unknown> | undefined> }>("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: resolve(cwd).split(/[\\/]/).pop() ?? "workspace" }],
    capabilities: {
      workspace: { configuration: true, workspaceFolders: true },
      textDocument: { [capability]: { dynamicRegistration: false } },
    },
  }, 15_000);
  if (!supportsCapability(initialized.capabilities?.[capability])) {
    throw new Error(`LSP server did not advertise textDocument/${String(capability)} support`);
  }
  session.notify("initialized", {});
};

export const openRelationDocuments = (
  session: LspSession,
  files: readonly string[],
  languageId: string,
): ReadonlyMap<string, string> => {
  const sources = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    sources.set(file, source);
    session.notify("textDocument/didOpen", {
      textDocument: { uri: pathToFileURL(file).href, languageId, version: 1, text: source },
    });
  }
  return sources;
};

export const warmupRelationDocuments = async (
  session: LspSession,
  files: readonly string[],
  requestTimeoutMs: number,
): Promise<boolean> => {
  let incomplete = false;
  for (const file of files) {
    try {
      await session.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(file).href } }, requestTimeoutMs);
    } catch {
      incomplete = true;
    }
  }
  return incomplete;
};

export const relationPositionForOffset = (source: string, offset: number): { readonly line: number; readonly character: number } => {
  const prefix = source.slice(0, offset);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  return { line: prefix.slice(0, lineStart).split("\n").length - 1, character: offset - lineStart };
};

export const relationRelativeFile = (cwd: string, file: string): string => relative(cwd, file).replace(/\\/g, "/");

export const relationRepositoryPath = (cwd: string, uri: string): string | undefined => {
  try {
    const canonical = (value: string): string => {
      try { return realpathSync.native(value); } catch { return value; }
    };
    const path = canonical(fileURLToPath(uri));
    const root = canonical(resolve(cwd));
    const fromRoot = relative(root, path);
    return fromRoot === "" || (!fromRoot.startsWith("..") && !fromRoot.includes("../"))
      ? fromRoot.replace(/\\/g, "/")
      : undefined;
  } catch {
    return undefined;
  }
};

export const relationDefinitionLocations = (value: unknown): readonly { readonly file: string; readonly line: number }[] => {
  const locations = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return locations.flatMap((entry): { file: string; line: number }[] => {
    if (!entry || typeof entry !== "object") return [];
    const location = entry as { uri?: unknown; range?: { start?: { line?: unknown } } };
    return typeof location.uri === "string" && typeof location.range?.start?.line === "number"
      ? [{ file: location.uri, line: location.range.start.line + 1 }]
      : [];
  });
};
