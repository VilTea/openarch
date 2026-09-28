import { Effect } from "effect";
import { resolve } from "node:path";
import type { FileAst } from "../domain/ast";
import type { ChangeSetContext, ChangeSetFile } from "../anti-patterns/engine";
import { analyzeSemanticChanges, type SemanticChange, type SemanticChangeAnalysis, type SemanticDeclarationAmbiguity } from "../domain/semanticChanges";
import { classifyFileKindWithPolicy } from "../domain/testGovernance";
import { readProjectFileKindRules } from "../projectFiles";
import { ParserService } from "../port/ParserService";
import { toPosixPath } from "../infra/paths";
import { computeInternalCallShape } from "../domain/cohesion";

export interface SemanticBeforeMetrics {
  readonly weightedBranchTotal: number;
  readonly maxFuncBranch?: number;
  readonly nestingDepth: number;
  readonly loc: number;
  readonly externalPassthroughCalls: number;
  /**
   * 认知点形态事实（report-only）：机械分解会抬高声明数、降低连通度，
   * 而两者都不在 `localBurden` 族里，因此必须单独携带，不能用 0 冒充缺失。
   */
  readonly connectedness?: number;
  readonly functionCount?: number;
  /** 内部调用图形状的伴读值：单调用点助手占比（`null` 表示不可判定，不写 0）。 */
  readonly singleCallSiteRatio?: number;
}

/**
 * Semantic classification and structural comparison have different evidence
 * boundaries. A manual change kind must not turn an existing Git file into an
 * introduced one merely because its declaration surface was unavailable.
 */
export type SemanticBeforeState = "git" | "introduced" | "unavailable";

export interface SemanticFileProfile {
  readonly file: string;
  readonly changes: readonly SemanticChange[];
  /** Direct Git-AST structure, available independently from the chosen change kind. */
  readonly beforeMetrics?: SemanticBeforeMetrics;
  readonly beforeState: SemanticBeforeState;
  /** True when the change is a deletion and there is no after source to parse. */
  readonly deleted?: boolean;
  /**
   * True when declaration-level classification could not be proven for this file
   * (no readable source, or ambiguous declaration identities). The file is
   * degraded on its own; its siblings keep their automatic classification.
   */
  readonly unavailable?: boolean;
}

/** 单文件不可分类的失败事实；`ambiguity` 仅在声明身份歧义时出现。 */
export interface SemanticFileFailure {
  readonly path: string;
  readonly reason: string;
  readonly ambiguity?: SemanticDeclarationAmbiguity;
}

export type SemanticDiffReport =
  | { readonly availability: "available"; readonly profiles: readonly SemanticFileProfile[] }
  | {
    /**
     * 部分文件不可分类：其余文件的自动分类**仍然成立**，只有失败文件需要人工兜底。
     * 原因逐文件携带，调用方才能只对失败文件要求 override，而不是让一个歧义文件
     * 把整批降级成逐文件重算（缺陷 2026-09-25：一个 Java 重载文件毒化整批）。
     */
    readonly availability: "partial";
    readonly profiles: readonly SemanticFileProfile[];
    readonly reason: string;
    readonly failures: readonly SemanticFileFailure[];
  }
  | { readonly availability: "unavailable"; readonly profiles: readonly []; readonly reason: string };

export interface SemanticDiffOptions {
  /** Restricts a bounded revision to the files relevant to its caller's evidence question. */
  readonly paths?: readonly string[];
}

const beforeMetricsOf = (ast: FileAst): SemanticBeforeMetrics => {
  const callShape = computeInternalCallShape(ast.functions);
  return {
    weightedBranchTotal: ast.weightedBranchTotal ?? ast.branchCount,
    maxFuncBranch: ast.maxFuncBranch,
    nestingDepth: ast.nestingDepth,
    loc: ast.loc ?? 0,
    externalPassthroughCalls: ast.externalPassthroughCalls ?? ast.passthroughCalls,
    connectedness: callShape.connectedness,
    functionCount: ast.functionCount,
    ...(callShape.singleCallSiteRatio === null ? {} : { singleCallSiteRatio: callShape.singleCallSiteRatio }),
  };
};

/** 声明级分类成功时产出的文件画像（非生产文件也保留真实分类事实，兜底只在解析不可用时使用）。 */
const analyzedProfile = (
  result: Extract<SemanticChangeAnalysis, { availability: "available" }>,
  file: ChangeSetFile,
  before: FileAst | undefined,
): SemanticFileProfile => ({
  file: file.path,
  changes: result.changes,
  beforeState: before ? "git" : "introduced",
  ...(before ? { beforeMetrics: beforeMetricsOf(before) } : {}),
});

/**
 * 单文件声明级分类不可用时的**该文件**画像（只降级自己，不毒化整批）。
 * `unavailable: true` 让调用方能区分“证明没有声明变更”与“证明不了”，
 * 从而只对该文件要求人工兜底；`fallback()` 分支代表非生产文件的已知兜底，仍然成立。
 */
const unavailableProfile = (
  file: ChangeSetFile,
  before: FileAst | undefined,
  isNonProduction: boolean,
  fallback: () => SemanticFileProfile,
): SemanticFileProfile => isNonProduction
  ? fallback()
  : {
    file: file.path,
    changes: [],
    beforeState: before ? "git" : "unavailable",
    unavailable: true,
    ...(before ? { beforeMetrics: beforeMetricsOf(before) } : {}),
  };

/**
 * Converts a bounded Git before/after change set into declaration-level facts.
 * Git is supplied by the CLI/application boundary; project scripts never call
 * this use case or receive revision source.
 */
export const analyzeChangeSetSemantics = (cwd: string, changeSet: ChangeSetContext, options: SemanticDiffOptions = {}) =>
  Effect.gen(function* () {
    if (changeSet.availability !== "available") {
      const reason = changeSet.reason ?? "Git change set is incomplete";
      return changeSet.availability === "partial"
        ? { availability: "partial", profiles: [], reason, failures: [] } satisfies SemanticDiffReport
        : { availability: "unavailable", profiles: [], reason } satisfies SemanticDiffReport;
    }
    const parser = yield* ParserService;
    const fileKindRules = readProjectFileKindRules(cwd);
    const profiles: SemanticFileProfile[] = [];
    const failures: SemanticFileFailure[] = [];
    const requested = options.paths ? new Set(options.paths.map((path) => toPosixPath(path))) : undefined;
    const files = requested ? changeSet.files.filter((file) => requested.has(toPosixPath(file.path))) : changeSet.files;
    if (requested && files.length === 0) {
      return { availability: "unavailable", profiles: [], reason: "requested historical files are absent from the revision" } satisfies SemanticDiffReport;
    }
    for (const file of files) {
      const isNonProduction = classifyFileKindWithPolicy(file.path, fileKindRules) !== "production";
      const fallback = (): SemanticFileProfile => ({
        file: file.path,
        changes: [{ anchor: "non-production:file", kind: "function_body" }],
        beforeState: file.kind === "added" ? "introduced" : "unavailable",
        ...(file.kind === "deleted" ? { deleted: true } : {}),
      });
      // 失败只累积、不提前 return：一个不可分类的文件不再是整批的判决。
      let parsedBefore: FileAst | undefined;
      const failed = (reason: string, ambiguity?: SemanticDeclarationAmbiguity): void => {
        failures.push({ path: file.path, reason, ...(ambiguity ? { ambiguity } : {}) });
        profiles.push(unavailableProfile(file, parsedBefore, isNonProduction, fallback));
      };
      if (file.kind === "deleted") {
        const path = resolve(cwd, file.path);
        const parsedBeforeOption = file.beforeText
          ? yield* parser.parseText(path, file.beforeText).pipe(Effect.option)
          : undefined;
        const before = parsedBeforeOption && parsedBeforeOption._tag === "Some" ? parsedBeforeOption.value : undefined;
        parsedBefore = before;
        if (!before) {
          if (isNonProduction) { profiles.push(fallback()); continue; }
          failed("cannot parse before source for deleted file");
          continue;
        }
        const result = analyzeSemanticChanges(before, undefined);
        if (result.availability !== "available") {
          if (isNonProduction) { profiles.push(fallback()); continue; }
          failed(result.reason, result.ambiguity);
          continue;
        }
        profiles.push({
          file: file.path,
          changes: result.changes,
          beforeState: "git",
          beforeMetrics: beforeMetricsOf(before),
          deleted: true,
        });
        continue;
      }
      if (!file.afterText) {
        failed("unreadable after source");
        continue;
      }
      const path = resolve(cwd, file.path);
      const parsed = yield* Effect.all({
        before: file.beforeText ? parser.parseText(path, file.beforeText).pipe(Effect.option) : Effect.succeed(undefined),
        after: parser.parseText(path, file.afterText).pipe(Effect.option),
      });
      const before = parsed.before && parsed.before._tag === "Some" ? parsed.before.value : undefined;
      const after = parsed.after && parsed.after._tag === "Some" ? parsed.after.value : undefined;
      parsedBefore = before;
      if (file.beforeText && !before) {
        if (isNonProduction) { profiles.push(fallback()); continue; }
        failed("cannot parse before source");
        continue;
      }
      if (!after) {
        if (isNonProduction) { profiles.push(fallback()); continue; }
        failed("cannot parse after source");
        continue;
      }
      const result = analyzeSemanticChanges(before, after);
      if (result.availability !== "available") {
        if (isNonProduction) { profiles.push(fallback()); continue; }
        failed(result.reason, result.ambiguity);
        continue;
      }
      profiles.push(analyzedProfile(result, file, before));
    }
    if (failures.length === 0) return { availability: "available", profiles } satisfies SemanticDiffReport;
    // 一个失败文件也没有产出时保持 unavailable（调用方仍按“整批不可用”处理）。
    if (profiles.length === 0) {
      return { availability: "unavailable", profiles: [], reason: failures.map((failure) => `${failure.path}: ${failure.reason}`).join("; ") } satisfies SemanticDiffReport;
    }
    return {
      availability: "partial",
      profiles,
      reason: failures.map((failure) => `${failure.path}: ${failure.reason}`).join("; "),
      failures,
    } satisfies SemanticDiffReport;
  });
