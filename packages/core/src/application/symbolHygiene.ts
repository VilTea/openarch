import { Effect } from "effect";
import { readProjectLanguages } from "../projectFiles";
import { projectRoot, toAbsolute, toRelative } from "../infra/paths";
import { StorageService } from "../port/StorageService";
import { SymbolUseService } from "../port/SymbolUseService";
import type { SymbolUseDemand } from "../port/SymbolUseService";
import type { ImplicitEdge } from "../domain/graph";
import type { SemanticFileProfile } from "./semanticDiff";

/** Application has no language branches; adapters report availability for each configured language. */
export const collectSymbolUseReports = (cwd = projectRoot(), demand?: SymbolUseDemand, waitForDiagnostics = false) =>
  Effect.gen(function* () {
    const service = yield* SymbolUseService;
    return yield* service.collect({ cwd, languages: readProjectLanguages(cwd), ...(demand ? { demand } : {}), waitForDiagnostics });
  });

/**
 * 静态上界预筛（规格 §3.4）：变更文件在 baseline 中 inDegree=0（无文件 import 它）
 * → 符号消费者必为空（引用符号必须 import 其所在文件）→ 从 demand 中剔除，
 * 不启动 LSP。文件无 baseline entry（新增/未扫描）→ 上界未知 → 保守保留。
 *
 * 保守保留条件（2026-08-12 修复，测试跨文件分析启发 + 团队可用性）：
 * 1. Go 同包引用无 import 语句（同目录文件直接引用符号）→ baseline 无对应边，
 *    inDegree=0 仍可能有同包消费者 → 同目录存在其他 .go 文件时保留；
 * 2. 变更集含多文件时，变更文件互相 import 会改变 diff 图的 inDegree
 *    （baseline inDegree 是旧 imports 算的）→ 保守保留；
 * 3. 配置了 implicitDeps 时，baseline inDegree 可能不含最新隐式边 → 保守保留。
 */
export const prefilterStaticBoundEmpty = (
  profiles: readonly SemanticFileProfile[],
  options: { readonly implicitDeps?: readonly ImplicitEdge[] } = {},
) =>
  Effect.gen(function* () {
    const storage = yield* StorageService;
    const kept: SemanticFileProfile[] = [];
    const multiFileChange = profiles.length > 1;
    const hasImplicitDeps = (options.implicitDeps?.length ?? 0) > 0;
    // Go 同包保守检查只需一次全量（仅当有 .go 文件且 inDegree=0 时才查）。
    let sameDirGoFiles = -1;
    let sameDirGoFor = "";
    for (const profile of profiles) {
      const entry = yield* storage.readFileMetrics(toAbsolute(profile.file));
      const inDegree = entry?.inDegree;
      if (inDegree === undefined || inDegree > 0) {
        kept.push(profile);
        continue;
      }
      // inDegree === 0：检查保守保留条件
      if (multiFileChange || hasImplicitDeps) {
        kept.push(profile);
        continue;
      }
      if (profile.file.endsWith(".go")) {
        if (sameDirGoFor !== profile.file) {
          const all = yield* storage.listAllFileMetrics();
          const dir = profile.file.slice(0, profile.file.lastIndexOf("/") + 1);
          sameDirGoFiles = all.filter(([path, e]) => e.fileKind === "production" && path.startsWith(dir) && path.endsWith(".go")).length;
          sameDirGoFor = profile.file;
        }
        if (sameDirGoFiles > 1) kept.push(profile);
        continue;
      }
      // 静态上界为空 → 逻辑必然 0 消费者
    }
    return kept;
  });

/**
 * 静态消费者候选（Go/Rust 校准 2026-08-05）：从 baseline 全量 entry 的
 * resolved imports 反推"谁 import 变更文件"，作为 LSP demand 的 consumerFiles
 * 引导——让 gopls/rust-analyzer 索引跨包消费者后 references 才能覆盖生产调用者。
 */
export const staticConsumerFilesFor = (profiles: readonly SemanticFileProfile[]) =>
  Effect.gen(function* () {
    const storage = yield* StorageService;
    const all = yield* storage.listAllFileMetrics();
    // 以相对路径为准（2026-08-12 修复，测试跨文件分析启发 + 团队可用性）：
    // baseline 全量 entry 的 path 与 imports 均持久化为相对路径（baselineEntry
    // toRelative），因此 targets 也统一转相对再比较——绝对路径因机器/checkout
    // 位置而异，跨成员共享 baseline 时会导致 consumerFiles 恒空。
    const targets = new Set(profiles.map((profile) => toRelative(profile.file)));
    const consumers = new Set<string>();
    for (const [path, entry] of all) {
      for (const imported of entry.imports ?? []) {
        const resolved = typeof imported === "string" ? imported : (imported as { resolvedPath?: string }).resolvedPath;
        if (resolved && targets.has(resolved)) consumers.add(path);
      }
    }
    return [...consumers].sort();
  });
