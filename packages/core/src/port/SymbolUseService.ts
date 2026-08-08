import { Context, Effect } from "effect";
import type { Language } from "../domain/ast";
import type { SymbolUseReport } from "../symbol-use/types";

/**
 * A bounded semantic question derived from a revision, not a project filter.
 * Providers may retain direct reference facts for these declarations, but the
 * result cannot claim repository-wide declaration or reference completeness.
 */
export interface SymbolUseDemand {
  readonly declarations: readonly {
    /** Repository-relative declaration file. */
    readonly file: string;
    /** Parser-derived declaration names changed in that file. */
    readonly names: readonly string[];
  }[];
  /**
   * File-level static consumers (reverse edges) of the changed files, used to
   * warm the LSP index for cross-package reference queries. Without this,
   * demand-mode references only cover the changed file's own package and
   * production callers are silently missed (calibration 2026-08-05: gopls
   * demand confirmed 0/15 production callers of NewRegistry).
   */
  readonly consumerFiles?: readonly string[];
}

export interface SymbolUseRequest {
  readonly cwd: string;
  readonly languages: readonly Language[];
  /** Omitted means an explicit full-repository analysis. */
  readonly demand?: SymbolUseDemand;
  /** LSP demand runs skip diagnostic readiness for speed; set to wait for a complete index (spec §3.4). */
  readonly waitForDiagnostics?: boolean;
}

/** Optional typed-language facts; unavailable providers return explicit reports, never fabricated emptiness. */
export interface SymbolUseService {
  readonly collect: (input: SymbolUseRequest) => Effect.Effect<readonly SymbolUseReport[]>;
}

export const SymbolUseService = Context.GenericTag<"SymbolUseService", SymbolUseService>("SymbolUseService");
