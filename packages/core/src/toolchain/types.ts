import type { Language } from "../domain/ast";

/** A discoverable local capability, not proof that a semantic provider has started or completed analysis. */
export type SemanticToolchainKind = "compiler" | "lsp" | "index";
export type SemanticToolchainAvailability = "available" | "partial" | "unavailable";
export type SemanticToolchainLocation = "bundled" | "environment" | "user-config" | "project-config" | "path" | "platform";

export interface SemanticToolchainFact {
  readonly id: string;
  readonly kind: SemanticToolchainKind;
  readonly availability: SemanticToolchainAvailability;
  readonly location?: SemanticToolchainLocation;
  readonly executable?: string;
  /** Machine-local launch environment (from toolchains.yml env); never persisted in governed-project configuration. */
  readonly env?: Readonly<Record<string, string>>;
  readonly version?: string;
  readonly reason?: string;
}

/** One language may require several independently discoverable tools (for example, JDK and JDT LS). */
export interface SemanticToolchainReport {
  readonly language: Language;
  readonly availability: SemanticToolchainAvailability;
  readonly tools: readonly SemanticToolchainFact[];
  readonly reason?: string;
}

export interface SemanticToolchainDiscoveryRequest {
  /** Project root is used only to reject project-local tool executables. */
  readonly cwd: string;
  readonly languages: readonly Language[];
}

export interface ToolchainCommandResult {
  readonly ok: boolean;
  readonly output?: string;
  readonly reason?: string;
}

/** Injectable host boundary: discovery never shells out through a project script or mutates an environment. */
export interface ToolchainRuntime {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly resolveExecutable: (name: string) => string | undefined;
  readonly exists: (path: string) => boolean;
  /** Explicit environment paths must identify files, not a directory that will fail at LSP launch. */
  readonly isFile: (path: string) => boolean;
  readonly readDirectory: (path: string) => readonly string[];
  /** Reads an external toolchain configuration file without treating it as project source. */
  readonly readFile: (path: string) => string | undefined;
  readonly hasPackage: (specifier: string) => boolean;
  readonly isProjectLocalExecutable: (cwd: string, executable: string) => boolean;
  readonly version: (executable: string, args: readonly string[]) => ToolchainCommandResult;
}
