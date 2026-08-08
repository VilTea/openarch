import { Effect } from "effect";
import { readProjectLanguages } from "../projectFiles";
import { projectRoot, toAbsolute } from "../infra/paths";
import { StorageService } from "../port/StorageService";
import { SymbolUseService } from "../port/SymbolUseService";
import type { SymbolUseDemand } from "../port/SymbolUseService";
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
 */
export const prefilterStaticBoundEmpty = (profiles: readonly SemanticFileProfile[]) =>
  Effect.gen(function* () {
    const storage = yield* StorageService;
    const kept: SemanticFileProfile[] = [];
    for (const profile of profiles) {
      const entry = yield* storage.readFileMetrics(toAbsolute(profile.file));
      const inDegree = entry?.inDegree;
      if (inDegree === 0) continue; // 静态上界为空 → 逻辑必然 0 消费者
      kept.push(profile);
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
    const targets = new Set(profiles.map((profile) => toAbsolute(profile.file)));
    const consumers = new Set<string>();
    for (const [path, entry] of all) {
      for (const imported of entry.imports ?? []) {
        const resolved = typeof imported === "string" ? imported : (imported as { resolvedPath?: string }).resolvedPath;
        if (resolved && targets.has(resolved)) consumers.add(path);
      }
    }
    return [...consumers].sort();
  });
