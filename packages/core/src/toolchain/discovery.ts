import { join } from "node:path";
import type { Language } from "../domain/ast";
import { readToolchainConfiguration, type ToolchainConfiguration } from "./config";
import type {
  SemanticToolchainAvailability,
  SemanticToolchainFact,
  SemanticToolchainReport,
  ToolchainRuntime,
} from "./types";

interface CommandToolchain {
  readonly id: string;
  readonly kind: SemanticToolchainFact["kind"];
  readonly names: readonly string[];
  /** Omitted for launchers whose only invocation starts a long-running server. */
  readonly versionArgs?: readonly string[];
}

const externalToolchains: Readonly<Record<Exclude<Language, "typescript" | "javascript">, readonly CommandToolchain[]>> = {
  python: [{ id: "pyright", kind: "lsp", names: ["pyright-langserver"], }],
  go: [
    { id: "gopls", kind: "lsp", names: ["gopls"], versionArgs: ["version"] },
    { id: "go", kind: "compiler", names: ["go"], versionArgs: ["version"] },
  ],
  rust: [
    { id: "rust-analyzer", kind: "lsp", names: ["rust-analyzer"], versionArgs: ["--version"] },
    { id: "cargo", kind: "compiler", names: ["cargo"], versionArgs: ["--version"] },
  ],
  java: [
    { id: "jdtls", kind: "lsp", names: ["jdtls"] },
    { id: "javac", kind: "compiler", names: ["javac"], versionArgs: ["-version"] },
  ],
};

const executableName = (runtime: ToolchainRuntime, name: string): string =>
  runtime.platform === "win32" && !name.endsWith(".exe") ? `${name}.exe` : name;

const configuredPathKey = (tool: CommandToolchain): string =>
  `OPENARCH_${tool.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_PATH`;

const platformJavaHomes = (runtime: ToolchainRuntime): readonly string[] => {
  if (runtime.platform === "win32") {
    const roots = [...new Set([runtime.environment.ProgramFiles, runtime.environment.ProgramW6432].filter((root): root is string => Boolean(root)))];
    return roots.flatMap((root) => [join(root, "Eclipse Adoptium"), join(root, "Java")])
      .flatMap((directory) => runtime.readDirectory(directory).map((entry) => join(directory, entry)));
  }
  if (runtime.platform === "darwin") return runtime.readDirectory("/Library/Java/JavaVirtualMachines")
    .map((entry) => join("/Library/Java/JavaVirtualMachines", entry, "Contents", "Home"));
  return runtime.readDirectory("/usr/lib/jvm").map((entry) => join("/usr/lib/jvm", entry));
};

const executableInHomes = (
  runtime: ToolchainRuntime,
  cwd: string,
  homes: readonly string[],
  tool: CommandToolchain,
  location: "environment" | "platform",
): { readonly path: string; readonly location: "environment" | "platform" } | undefined => {
  for (const home of homes) {
    const path = join(home, "bin", executableName(runtime, tool.names[0]));
    if (runtime.exists(path) && !runtime.isProjectLocalExecutable(cwd, path)) return { path, location };
  }
  return undefined;
};

interface ConfiguredExecutable {
  readonly executable?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly location: SemanticToolchainFact["location"];
  readonly label: string;
  readonly error?: string;
}

const configuredExecutable = (
  runtime: ToolchainRuntime,
  tool: CommandToolchain,
  configuration: ToolchainConfiguration,
): ConfiguredExecutable | undefined => {
  const environmentPath = runtime.environment[configuredPathKey(tool)];
  if (environmentPath) return { executable: environmentPath, location: "environment", label: configuredPathKey(tool) };
  const configured = configuration.overrides.get(tool.id);
  return configured
    ? { executable: configured.executable, env: configured.env, location: configured.location, label: configured.sourcePath, error: configured.error }
    : undefined;
};

const commandFact = (
  runtime: ToolchainRuntime,
  cwd: string,
  language: Language,
  tool: CommandToolchain,
  configuration: ToolchainConfiguration,
): SemanticToolchainFact => {
  const configured = configuredExecutable(runtime, tool, configuration);
  if (configured) {
    if (configured.error || !configured.executable || !runtime.exists(configured.executable) || !runtime.isFile(configured.executable)) {
      return { id: tool.id, kind: tool.kind, availability: "unavailable", reason: configured.error ?? `${configured.label} does not identify an executable` };
    }
    if (runtime.isProjectLocalExecutable(cwd, configured.executable)) {
      return { id: tool.id, kind: tool.kind, availability: "unavailable", reason: `${configured.label} resolves inside the governed project and is not used by OpenArch` };
    }
    if (!tool.versionArgs) return { id: tool.id, kind: tool.kind, availability: "available", location: configured.location, executable: configured.executable, env: configured.env };
    const version = runtime.version(configured.executable, tool.versionArgs);
    return version.ok
      ? { id: tool.id, kind: tool.kind, availability: "available", location: configured.location, executable: configured.executable, env: configured.env, version: version.output?.trim() }
      : { id: tool.id, kind: tool.kind, availability: "partial", location: configured.location, executable: configured.executable, env: configured.env, reason: version.reason ?? "version probe failed" };
  }
  const fromJavaHome = language === "java" && tool.id === "javac" && runtime.environment.JAVA_HOME
    ? executableInHomes(runtime, cwd, [runtime.environment.JAVA_HOME], tool, "environment")
    : undefined;
  const pathCandidates = tool.names.map((name) => runtime.resolveExecutable(name)).filter((path): path is string => Boolean(path));
  const fromPath = pathCandidates.find((path) => !runtime.isProjectLocalExecutable(cwd, path));
  const fromPlatform = language === "java" && tool.id === "javac" && !fromJavaHome && !fromPath
    ? executableInHomes(runtime, cwd, platformJavaHomes(runtime), tool, "platform")
    : undefined;
  const executable = fromJavaHome?.path ?? fromPath ?? fromPlatform?.path;
  const location = fromJavaHome?.location ?? (fromPath ? "path" : fromPlatform?.location);
  if (!executable || !location) {
    const localOnly = pathCandidates.length > 0 && pathCandidates.every((path) => runtime.isProjectLocalExecutable(cwd, path));
    return { id: tool.id, kind: tool.kind, availability: "unavailable", reason: localOnly ? `${tool.id} is available only inside the project and is not used by OpenArch` : `${tool.id} executable was not found` };
  }
  if (!tool.versionArgs) return { id: tool.id, kind: tool.kind, availability: "available", location, executable };
  const version = runtime.version(executable, tool.versionArgs);
  if (!version.ok) {
    return { id: tool.id, kind: tool.kind, availability: "partial", location, executable, reason: version.reason ?? "version probe failed" };
  }
  return { id: tool.id, kind: tool.kind, availability: "available", location, executable, version: version.output?.trim() };
};

const aggregateAvailability = (facts: readonly SemanticToolchainFact[]): SemanticToolchainAvailability => {
  if (facts.every((fact) => fact.availability === "available")) return "available";
  if (facts.some((fact) => fact.availability !== "unavailable")) return "partial";
  return "unavailable";
};

const bundledTypeScriptFact = (runtime: ToolchainRuntime): SemanticToolchainFact => runtime.hasPackage("typescript")
  ? { id: "typescript-compiler", kind: "compiler", availability: "available", location: "bundled" }
  : { id: "typescript-compiler", kind: "compiler", availability: "unavailable", reason: "typescript package is not resolvable" };

/**
 * Finds local semantic tooling without installing, starting, or trusting it as a symbol-use result.
 * The returned fact is an input to future providers; it is never equivalent to complete references.
 */
export const discoverSemanticToolchains = (
  cwd: string,
  languages: readonly Language[],
  runtime: ToolchainRuntime,
): readonly SemanticToolchainReport[] => {
  const configuration = readToolchainConfiguration(cwd, runtime);
  return [...new Set(languages)].map((language) => {
  const tools = language === "typescript" || language === "javascript"
    ? [bundledTypeScriptFact(runtime)]
    : externalToolchains[language].map((tool) => commandFact(runtime, cwd, language, tool, configuration));
  const availability = aggregateAvailability(tools);
  return {
    language,
    availability,
    tools,
    ...(availability === "unavailable" ? { reason: "no complete semantic toolchain is discoverable for this language" } : {}),
  };
  });
};
