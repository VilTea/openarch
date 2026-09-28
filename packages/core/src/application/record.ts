// packages/core/src/application/record.ts
//
// record use case（design v5.2 §5.4 conclude）。
// 从 structural baseline 与 sealed history projection 提取最高历史 CRL，生成经验条目模板。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Effect } from "effect";
import { resolveDocumentStore } from "../document-store/DocumentStore";
import { RECORD_SECTIONS } from "../document-store/DocumentFill";
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
  /** Omits the generator's guidance comments; the required sections stay. */
  readonly noComments?: boolean;
}

export type RecordCategory = "anti_patterns" | "patterns" | "decisions";

export interface RecordOutput {
  readonly filePath: string;
  readonly category: RecordCategory;
}

const headerFor = (
  locale: "zh" | "en", title: string, date: string, maxCrl: number, topFile: string, topMaxFuncBranch: number, nFiles: number,
): string => locale === "en"
  ? `# ${title}
Date: ${date}
Source: openarch docs record
Highest historical CRL: ${maxCrl > 0 ? `${topFile} (CRL=${maxCrl.toFixed(1)}, maxFuncBranch=${topMaxFuncBranch})` : "no sealed history data"}
Files: ${nFiles}`
  : `# ${title}
日期: ${date}
来源: openarch docs record
最高历史 CRL: ${maxCrl > 0 ? `${topFile} (CRL=${maxCrl.toFixed(1)}, maxFuncBranch=${topMaxFuncBranch})` : "无 sealed history 数据"}
文件数: ${nFiles}`;

/** Renders the required sections from their single definition in
 *  `document-store/DocumentFill`, optionally with the guidance comments. */
const templateFor = (locale: "zh" | "en", withComments: boolean) =>
  (title: string, date: string, maxCrl: number, topFile: string, topMaxFuncBranch: number, nFiles: number): string => {
    const sections = RECORD_SECTIONS[locale]
      .map((section) => withComments ? `## ${section.heading}\n<!-- ${section.guidance} -->` : `## ${section.heading}`)
      .join("\n\n");
    return `${headerFor(locale, title, date, maxCrl, topFile, topMaxFuncBranch, nFiles)}\n\n${sections}\n`;
  };

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
        writeFileSync(outFile, templateFor(input.locale ?? "zh", !input.noComments)(input.title.trim(), today, maxCrl, topFile, topBranch, index?.meta.nFiles ?? 0), { flag: "wx" });
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
