import { isAbsolute, join, resolve } from "node:path";
import { load } from "js-yaml";
import type { SemanticToolchainLocation, ToolchainRuntime } from "./types";

export type ToolchainConfigScope = "user" | "project";

interface ToolchainConfigFile {
  readonly version?: unknown;
  readonly tools?: unknown;
}

export interface ToolchainConfigPaths {
  readonly user?: string;
  readonly project: string;
}

export interface ToolchainExecutableOverride {
  readonly executable?: string;
  /** Optional machine-local environment for launching this tool (e.g. gopls needs the Go toolchain on PATH). */
  readonly env?: Readonly<Record<string, string>>;
  readonly location: Extract<SemanticToolchainLocation, "user-config" | "project-config">;
  readonly sourcePath: string;
  readonly error?: string;
}

export interface ToolchainConfiguration {
  readonly paths: ToolchainConfigPaths;
  readonly overrides: ReadonlyMap<string, ToolchainExecutableOverride>;
  readonly diagnostics: readonly string[];
}

const userConfigRoot = (runtime: Pick<ToolchainRuntime, "platform" | "environment">): string | undefined => {
  if (runtime.platform === "win32") return runtime.environment.APPDATA ?? runtime.environment.USERPROFILE;
  const home = runtime.environment.HOME;
  if (!home) return undefined;
  if (runtime.platform === "darwin") return join(home, "Library", "Application Support");
  return runtime.environment.XDG_CONFIG_HOME ?? join(home, ".config");
};

/** Machine-wide config is portable by convention, without requiring one environment variable per tool. */
export const userToolchainConfigPath = (runtime: Pick<ToolchainRuntime, "platform" | "environment">): string | undefined => {
  const configured = runtime.environment.OPENARCH_TOOLCHAINS_FILE;
  if (configured) return resolve(configured);
  const root = userConfigRoot(runtime);
  return root ? join(root, runtime.platform === "win32" ? "OpenArch" : "openarch", "toolchains.yml") : undefined;
};

/** This deliberately remains local to one checkout: it may contain machine-specific absolute paths. */
export const projectToolchainConfigPath = (cwd: string): string => join(resolve(cwd), ".openarch", "toolchains.local.yml");

export const toolchainConfigPaths = (cwd: string, runtime: Pick<ToolchainRuntime, "platform" | "environment">): ToolchainConfigPaths => ({
  user: userToolchainConfigPath(runtime),
  project: projectToolchainConfigPath(cwd),
});

const configEntries = (
  path: string,
  location: ToolchainExecutableOverride["location"],
  runtime: Pick<ToolchainRuntime, "readFile">,
): { readonly entries: readonly [string, ToolchainExecutableOverride][]; readonly diagnostic?: string } => {
  const text = runtime.readFile(path);
  if (text === undefined) return { entries: [] };
  try {
    const root = load(text) as ToolchainConfigFile | undefined;
    if (!root || typeof root !== "object" || Array.isArray(root) || root.version !== 1) {
      return { entries: [], diagnostic: `${path}: expected mapping with version: 1` };
    }
    if (root.tools === undefined) return { entries: [] };
    if (!root.tools || typeof root.tools !== "object" || Array.isArray(root.tools)) {
      return { entries: [], diagnostic: `${path}: tools must be a mapping` };
    }
    return {
      entries: Object.entries(root.tools as Record<string, unknown>).map(([id, value]) => {
        const entry = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
        const executable = entry?.executable;
        const env = entry && typeof entry.env === "object" && entry.env !== null && !Array.isArray(entry.env)
          ? Object.fromEntries(Object.entries(entry.env as Record<string, unknown>).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, v as string]))
          : undefined;
        const error = typeof executable !== "string" || executable.trim() === ""
          ? "expected a non-empty executable string"
          : !isAbsolute(executable)
            ? "executable must be an absolute path"
            : undefined;
        return [id, { executable: typeof executable === "string" ? executable : undefined, env, location, sourcePath: path, error }] as const;
      }),
    };
  } catch (error) {
    return { entries: [], diagnostic: `${path}: ${error instanceof Error ? error.message : "cannot parse YAML"}` };
  }
};

/** Reads user then checkout-local overrides. The latter wins without changing project policy or Git state. */
export const readToolchainConfiguration = (cwd: string, runtime: Pick<ToolchainRuntime, "platform" | "environment" | "readFile">): ToolchainConfiguration => {
  const paths = toolchainConfigPaths(cwd, runtime);
  const user = paths.user ? configEntries(paths.user, "user-config", runtime) : { entries: [] as const };
  const project = configEntries(paths.project, "project-config", runtime);
  return {
    paths,
    overrides: new Map([...user.entries, ...project.entries]),
    diagnostics: [user.diagnostic, project.diagnostic].filter((message): message is string => Boolean(message)),
  };
};

export const TOOLCHAIN_CONFIG_TEMPLATE = `# OpenArch external semantic toolchains (machine-local; never commit project overrides)
# 路径准则：executable 用当前平台的字面路径（Windows 用反斜杠或正斜杠均可，
# Node fs 两者皆认）；值用单引号（YAML 双引号会把 Windows 反斜杠当转义序列，
# 例如 \\w / \\l 会触发 unknown escape sequence）。
# env 可选：工具的启动环境（机器本地；不进 governed 配置）。典型场景是 gopls
# 内部调用 go 命令——go 不在全局 PATH 时，把 .tools 的 go bin 注入 PATH：
#   tools:
#     gopls:
#       executable: 'E:\\workspace\\llm\\.tools\\bin\\gopls.exe'
#       env:
#         PATH: 'E:\\workspace\\llm\\.tools\\go\\bin;%PATH%'
#     go:
#       executable: 'E:\\workspace\\llm\\.tools\\go\\bin\\go.exe'
version: 1
tools: {}
`;
