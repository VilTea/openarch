// packages/core/src/application/record.ts
//
// record use case（design v5.2 §5.4 conclude）。
// 从 structural baseline 与 sealed history projection 提取最高历史 CRL，生成经验条目模板。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Effect } from "effect";
import { resolveDocumentStore } from "../document-store/DocumentStore";
import { maxFuncWeightedBranchOf } from "../domain/branchMetrics";
import { replayHistoricalCrl } from "./governance/historyCrl";
import { StorageService } from "../port/StorageService";
import { participatesInPopulation } from "../domain/fileParticipation";
import { toPosixPath } from "../infra/paths";

export interface RecordInput {
  readonly title: string;
  readonly docsDir?: string;       // override for testing
  /** Explicit durable knowledge category; defaults to a verified success pattern. */
  readonly category?: RecordCategory;
  /** Keeps history replay and generated document date on one observation time. */
  readonly now?: Date;
  /** Template locale; the CLI passes the command locale so non-Chinese projects get local templates. */
  readonly locale?: "zh" | "en";
}

export type RecordCategory = "anti_patterns" | "patterns" | "decisions";

export interface RecordOutput {
  readonly filePath: string;
  readonly category: RecordCategory;
}

const TEMPLATE_ZH = (title: string, date: string, maxCrl: number, topFile: string, topMaxFuncBranch: number, nFiles: number) =>
  `# ${title}
日期: ${date}
来源: openarch docs record
最高历史 CRL: ${maxCrl > 0 ? `${topFile} (CRL=${maxCrl.toFixed(1)}, maxFuncBranch=${topMaxFuncBranch})` : "无 sealed history 数据"}
文件数: ${nFiles}

## 背景
<!-- 必填：什么改动触发了这条记录？涉及哪些文件？gate 输出是什么？
  示例："修改 CelAdapter.ts，新增 comparison() 方法。gate WARN: max_func_branch > 8 (9.3)；diff 冲击 I_push=12.1（report-only 路由证据）" -->

## 分析
<!-- 必填：为什么触发规则？是单次改动过大还是架构问题？CRL 趋势如何？
  示例："CelAdapter 手写递归下降 parser，所有语法节点解析在同一文件——天生高分支，非单次改动问题。CRL=5.6 偏低，可接受。" -->

## 应对
<!-- 必填：做了什么决定？accept / refactor / defer？结果如何？
  示例："接受 WARN——手写 parser 是临时方案。Phase 2 换完整 CEL 实现后自然解决。" -->

## 教训
<!-- 必填：下次遇到类似情况怎么处理？这是可复用的认知吗？
  示例："parser/compiler 类代码可能有较高的单函数复杂度。先确认分支集中位置，再按项目路径分类设 max_func_branch 阈值；文件总量和顶层分派在校准前只作报告。" -->
`;

const TEMPLATE_EN = (title: string, date: string, maxCrl: number, topFile: string, topMaxFuncBranch: number, nFiles: number) =>
  `# ${title}
Date: ${date}
Source: openarch docs record
Highest historical CRL: ${maxCrl > 0 ? `${topFile} (CRL=${maxCrl.toFixed(1)}, maxFuncBranch=${topMaxFuncBranch})` : "no sealed history data"}
Files: ${nFiles}

## Background
<!-- REQUIRED: what change triggered this record? Which files were involved and what did the gate output say?
  Example: "Modified CelAdapter.ts to add comparison(). Gate WARN: max_func_branch > 8 (9.3); diff impact I_push=12.1 (report-only routing evidence)." -->

## Analysis
<!-- REQUIRED: why did the rule trigger? Is this a one-off large change or a structural problem, and how is the CRL trend?
  Example: "CelAdapter is a hand-written recursive-descent parser; every syntax node parses in one file, so high branching is intrinsic rather than a one-off change. CRL=5.6 is low and acceptable." -->

## Response
<!-- REQUIRED: what decision was made - accept / refactor / defer - and what was the outcome?
  Example: "Accepted the WARN: the hand-written parser is temporary and disappears after the Phase 2 CEL implementation." -->

## Lessons
<!-- REQUIRED: how should this be handled next time, and is this reusable knowledge?
  Example: "Parser/compiler code can legitimately have high per-function complexity. Confirm where branching concentrates first, then calibrate max_func_branch thresholds by project path class; file totals and top-level dispatch stay report-only before calibration." -->
`;

const templateFor = (locale: "zh" | "en") => locale === "en" ? TEMPLATE_EN : TEMPLATE_ZH;

const errnoCodeOf = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
};

export const record = (input: RecordInput) =>
  Effect.gen(function* () {
    const storage = yield* StorageService;
    const store = input.docsDir ? null : resolveDocumentStore(process.cwd());
    const docsDir = input.docsDir ?? store?.scopeRoot;
    if (!docsDir || !existsSync(docsDir)) {
      return { error: "项目文档库未配置。运行 openarch init --docs-store project，或显式关联 shared document store" } as const;
    }

    const now = input.now ?? new Date();
    const [index, metrics, history] = yield* Effect.all([
      storage.readIndex(), storage.listAllFileMetrics(), storage.readAllHistory(),
    ]);
    const crlByFile = replayHistoricalCrl(history, now);
    let maxCrl = 0, topFile = "", topBranch = 0;
    for (const [, metric] of metrics) {
      if (!participatesInPopulation(metric.fileKind, "production-governance")) continue;
      const historicalCrl = crlByFile.get(metric.path) ?? crlByFile.get(toPosixPath(metric.path)) ?? 0;
      if (historicalCrl > maxCrl) {
        maxCrl = historicalCrl;
        topFile = metric.path;
        topBranch = maxFuncWeightedBranchOf(metric);
      }
    }

    const today = now.toISOString().slice(0, 10);
    const category = input.category ?? "patterns";
    const outDir = category === "decisions" ? join(docsDir, category) : join(docsDir, "wisdom", category);
    const safeTitle = input.title.trim()
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\.\.+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/[^\p{L}\p{N}._-]/gu, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 40);
    if (!safeTitle) return { error: "记录标题不能为空或不能形成安全文件名" } as const;
    const outFile = join(outDir, `${today}-${safeTitle}.md`);
    const outputRoot = resolve(docsDir);
    const outputPath = resolve(outFile);
    const outputRelative = relative(outputRoot, outputPath);
    if (isAbsolute(outputRelative) || outputRelative.startsWith("..")) return { error: "记录输出路径越过文档库边界" } as const;
    const writeResult = yield* Effect.either(Effect.try({
      try: () => {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(outFile, templateFor(input.locale ?? "zh")(input.title.trim(), today, maxCrl, topFile, topBranch, index?.meta.nFiles ?? 0), { flag: "wx" });
      },
      catch: (error) => error,
    }));
    if (writeResult._tag === "Left") {
      const error = writeResult.left;
      const detail = error instanceof Error ? error.message : String(error);
      return { error: errnoCodeOf(error) === "EEXIST" ? "同名经验文档已存在，未覆盖；请更换标题" : `经验文档写入失败: ${detail}` } as const;
    }
    return { filePath: outFile, category } as RecordOutput;
  });
