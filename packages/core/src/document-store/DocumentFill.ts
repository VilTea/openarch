import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocumentStore } from "./DocumentStore";
import { scanMarkdown, type MarkdownScan } from "./MarkdownStructure";

/** Generated record templates carry one of these provenance lines as their own
 *  line; only those documents participate in unfilled detection, so ordinary
 *  Markdown (including capability assets that merely quote the markers) is
 *  never flagged. Templates are generated in the locale chosen at record time.
 *
 *  格式迁移兼容：`d7c3cea6` 之前生成器写 `来源/Source: openarch record`，之后改写
 *  `… openarch docs record`，而本判据诞生时（`33b3f759`）只认新写法——共享文档库里
 *  的历史记录因此整批落在判定人口之外（实测 26 篇中 24 篇为旧格式）。两种写法都是
 *  生成器产出，同属判定人口，故显式并列；`docs` 既不放进可选组也不加通配，避免把
 *  手写来源（如 `来源: OpenArch dogfood`，其正文是 `观察/应对/边界` 而非必填标题）
 *  顺手纳入而改变人口语义。判据本身仍只认这一条来源行。 */
const RECORD_ORIGIN = /^[ \t]*(?:来源|source): openarch (?:docs )?record[ \t]*$/imu;

/** 末尾括号注解（中英文括号），例如 `教训（通用经验）` —— 作者给必填标题加注解是日常
 *  可达的写法，精确匹配会让该小节**静默**退出判定。 */
const TRAILING_ANNOTATION = /[ \t]*[（(][^（()）]*[）)][ \t]*$/u;

/** 必填小节标题的**唯一规范化入口**：只容忍尾部差异（末尾括号注解，可带内部空白），
 *  **不**做前缀或包含匹配——`教训与反思` 这类标题不是 `教训`，不得因包含关系被误判。
 *  反复剥尽嵌套注解，直到不再变化（注解内再带注解时不会残留半个标题）。 */
const normalizeHeading = (heading: string): string => {
  let normalized = heading.trim();
  let stripped = normalized.replace(TRAILING_ANNOTATION, "").trim();
  while (stripped !== normalized) {
    normalized = stripped;
    stripped = normalized.replace(TRAILING_ANNOTATION, "").trim();
  }
  return normalized;
};

/** One required section of a generated record template. */
export interface RecordSection {
  readonly heading: string;
  /** Guidance rendered as an HTML comment unless the caller records with --no-comments. */
  readonly guidance: string;
}

/** Single authority for the record template shape: `application/record.ts`
 *  renders exactly this list and the unfilled predicate below checks exactly
 *  this list, so the generator and the completeness gate can never drift apart. */
export const RECORD_SECTIONS: Readonly<Record<"zh" | "en", readonly RecordSection[]>> = {
  zh: [
    {
      heading: "背景",
      guidance: `必填：什么改动触发了这条记录？涉及哪些文件？gate 输出是什么？
  示例："修改 CelAdapter.ts，新增 comparison() 方法。gate WARN: max_func_branch > 8 (9.3)；diff 冲击 I_push=12.1（report-only 路由证据）"`,
    },
    {
      heading: "分析",
      guidance: `必填：为什么触发规则？是单次改动过大还是架构问题？CRL 趋势如何？
  示例："CelAdapter 手写递归下降 parser，所有语法节点解析在同一文件——天生高分支，非单次改动问题。CRL=5.6 偏低，可接受。"`,
    },
    {
      heading: "应对",
      guidance: `必填：做了什么决定？accept / refactor / defer？结果如何？
  示例："接受 WARN——手写 parser 是临时方案。Phase 2 换完整 CEL 实现后自然解决。"`,
    },
    {
      heading: "教训",
      guidance: `必填：下次遇到类似情况怎么处理？这是可复用的认知吗？
  示例："parser/compiler 类代码可能有较高的单函数复杂度。先确认分支集中位置，再按项目路径分类设 max_func_branch 阈值；文件总量和顶层分派在校准前只作报告。"`,
    },
  ],
  en: [
    {
      heading: "Background",
      guidance: `REQUIRED: what change triggered this record? Which files were involved and what did the gate output say?
  Example: "Modified CelAdapter.ts to add comparison(). Gate WARN: max_func_branch > 8 (9.3); diff impact I_push=12.1 (report-only routing evidence)."`,
    },
    {
      heading: "Analysis",
      guidance: `REQUIRED: why did the rule trigger? Is this a one-off large change or a structural problem, and how is the CRL trend?
  Example: "CelAdapter is a hand-written recursive-descent parser; every syntax node parses in one file, so high branching is intrinsic rather than a one-off change. CRL=5.6 is low and acceptable."`,
    },
    {
      heading: "Response",
      guidance: `REQUIRED: what decision was made - accept / refactor / defer - and what was the outcome?
  Example: "Accepted the WARN: the hand-written parser is temporary and disappears after the Phase 2 CEL implementation."`,
    },
    {
      heading: "Lessons",
      guidance: `REQUIRED: how should this be handled next time, and is this reusable knowledge?
  Example: "Parser/compiler code can legitimately have high per-function complexity. Confirm where branching concentrates first, then calibrate max_func_branch thresholds by project path class; file totals and top-level dispatch stay report-only before calibration."`,
    },
  ],
};

const REQUIRED_HEADINGS = new Set(
  [...RECORD_SECTIONS.zh, ...RECORD_SECTIONS.en].map((section) => section.heading),
);

const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/u;
/** Filler that carries no reusable knowledge, e.g. a bare bullet or "TBD".
 *  Deliberately narrow: a terse but real answer such as "None." must not block a commit. */
const PLACEHOLDER_BODY = /^(?:tbd|todo|待填|待补充|待定|n\/a|\.+|-+|\*+)[.。!！?？]*$/iu;

/** Removes HTML comments so that the generator's own guidance never counts as
 *  the content of the section it describes. Comment spans are proven by
 *  `MarkdownStructure`'s single-pass state machine: a `<!-- ... -->` inside a
 *  fenced code block is code and stays, and an unclosed comment removes nothing
 *  beyond what `-->` proves. Line endings are preserved. */
export const stripHtmlComments = (content: string): string => scanMarkdown(content).withoutComments;

interface MarkdownSection {
  readonly heading: string;
  readonly body: string;
}

/** Splits a document into heading sections; text before the first heading is ignored.
 *  The scan already removed the proven HTML comments, so no second whole-document pass
 *  is needed; a `#` inside a fenced code block is code and never opens a section. */
const sectionsOf = (scan: MarkdownScan): readonly MarkdownSection[] => {
  const sections: MarkdownSection[] = [];
  let heading: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (heading !== undefined) sections.push({ heading, body: body.join("\n") });
  };
  for (const line of scan.lines) {
    const match = line.inFence ? null : HEADING.exec(line.text);
    if (match) {
      flush();
      heading = (match[1] ?? "").trim();
      body = [];
      continue;
    }
    if (heading !== undefined) body.push(line.text);
  }
  flush();
  return sections;
};

const isPlaceholderBody = (body: string): boolean => {
  const text = body
    .split(/\r?\n/u)
    .map((line) => line.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]*/u, "").trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
  return text.length === 0 || PLACEHOLDER_BODY.test(text);
};

/** True when a generated record template still has a required section without
 *  real content. Guidance comments are stripped by the structural scan first, so a
 *  fully filled record is never flagged merely for retaining them.
 *
 *  Fail-closed: an unclosed code fence or HTML comment makes the section structure
 *  unprovable, so the document is reported as unfilled instead of silently passing
 *  (「不可测 ≠ 0」——证明不了就不放行）。
 *
 *  必填小节按 `normalizeHeading` 规范化后比对：`## 教训（通用经验）` 仍是必填小节，
 *  `## 教训与反思` 不是。 */
export const isUnfilledRecordDocument = (content: string): boolean => {
  if (!RECORD_ORIGIN.test(content)) return false;
  const scan = scanMarkdown(content);
  if (scan.unterminatedFence || scan.unterminatedComment) return true;
  return sectionsOf(scan).some((section) => REQUIRED_HEADINGS.has(normalizeHeading(section.heading)) && isPlaceholderBody(section.body));
};

/**
 * Lists record templates whose required sections are still placeholders.
 * `changed` is a set of store-relative paths, exactly as produced by
 * `updateDocumentIndex`; `stagedContent` mirrors the pre-commit bytes.
 */
export const unfilledDocuments = (
  store: DocumentStore,
  changed: ReadonlySet<string>,
  stagedContent?: ReadonlyMap<string, string>,
): readonly string[] => {
  const unfilled: string[] = [];
  for (const relativePath of changed) {
    if (!relativePath || relativePath.startsWith("../") || !relativePath.toLowerCase().endsWith(".md")) continue;
    const absolute = join(store.scopeRoot, relativePath);
    const content = stagedContent?.get(absolute) ?? (existsSync(absolute) ? readFileSync(absolute, "utf8") : null);
    if (content !== null && isUnfilledRecordDocument(content)) unfilled.push(relativePath);
  }
  return unfilled;
};
