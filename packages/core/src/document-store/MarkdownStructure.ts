import { load } from "js-yaml";

/** Markdown 块结构的**唯一权威扫描入口**（`DocumentFingerprint` 与 `DocumentFill` 共用）。
 *
 *  审计背景（内部审计记录 §2 C-1）：旧实现用 `[\s\S]*?` "猜" frontmatter /
 *  围栏 / HTML 注释的边界，归一化结果取决于文本里的字符组合而不是文档结构——围栏内的
 *  `<!-- -->` 被当注释剥掉、`~~~` 围栏里的 ``` 会剥错区间、文档开头的水平线到下一个 `---`
 *  之间的真实正文会被当 frontmatter 删除。
 *
 *  这里的判据是"只删除已被证明的区间"：
 *   - fenced code block：整行成立的围栏定界行 + 同字符、不短于开围栏的闭围栏（CommonMark 判据）；
 *   - HTML 注释：`<!--` … `-->`（HTML 注释无可嵌套语法，见 `<!--` 置位、见 `-->` 复位即可，无需回溯），
 *     且**围栏内与行内代码片段内不生效**（那里的 `<!--` 是代码而不是注释起始）；
 *   - frontmatter：只在文档开头、行精确的 `---` 定界、且区间内容能被 `js-yaml` 解析为映射
 *     （结构化证明，不是"再聪明一点的正则"）。
 *
 *  两条边界是刻意选择的、可断言的方向：
 *   - 只删**成对**的注释区间，且区间之外逐字节保留（不引入行尾归一化）；未闭合的 `<!--` 不删任何文本；
 *   - 未闭合的围栏不删任何文本、只置位 `unterminatedFence`。
 *  证明不了就不删——宁可多留证据，也不静默产出一个"看似干净"的结果。 */

/** frontmatter 定界符（Jekyll/Go 风格；Markdown 本身没有 frontmatter 概念，此处沿用生态惯例）。 */
const FRONTMATTER_DELIMITER = "---";

/** frontmatter 只允许出现在文档开头且在**有界**头部内闭合：超出该行数的 `---` 一律按正文处理。
 *  512 行足以覆盖真实 frontmatter；越界的方向是"当作正文"（不删证据），而不是继续无界地找下一个 `---`。 */
export const FRONTMATTER_MAX_LINES = 512;

/** 开围栏：≤3 空格缩进 + 3 个及以上反引号或波浪号（CommonMark 的围栏判据）。 */
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/u;

interface RawLine {
  readonly text: string;
  readonly eol: string;
  /** 该行在原文中的起始偏移（用于把行内区间换算成原文区间）。 */
  readonly start: number;
}

interface FenceOpener {
  readonly char: string;
  readonly length: number;
}

interface Span {
  readonly from: number;
  readonly to: number;
}

/** 一行 Markdown 的结构分类（注释已按结构剥离）。 */
export interface MarkdownLine {
  /** 剥离已证明的 HTML 注释后的行文本；围栏内 / 行内代码片段内的 `<!--` 原样保留，
   *  frontmatter 行不扫注释（那是 YAML 内容）。 */
  readonly text: string;
  /** 该行属于**已证明闭合**的 fenced code block（含围栏定界行）。未闭合的围栏不置位。 */
  readonly inFence: boolean;
  /** 该行属于文档头部 frontmatter（含 `---` 定界行）。 */
  readonly frontmatter: boolean;
}

export interface MarkdownScan {
  readonly lines: readonly MarkdownLine[];
  /** 剥掉已证明的 HTML 注释后的整篇文本；除被删除的注释区间外逐字节保持原样（含 CRLF 行尾）。 */
  readonly withoutComments: string;
  /** 存在未闭合的 fenced code block：代码区间终点无法证明，文本被保留为正文。调用方必须 fail-closed。 */
  readonly unterminatedFence: boolean;
  /** 存在未闭合的 HTML 注释：该注释不删除任何文本（只删成对的 `<!-- … -->`）。调用方必须 fail-closed。 */
  readonly unterminatedComment: boolean;
}

const splitRawLines = (content: string): readonly RawLine[] => {
  const parts = content.split(/(\r?\n)/u);
  const lines: RawLine[] = [];
  let start = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index];
    const eol = parts[index + 1] ?? "";
    lines.push({ text, eol, start });
    start += text.length + eol.length;
  }
  return lines;
};

/** 行精确的 frontmatter 边界；返回正文起始下标（0 = 不是 frontmatter）。
 *  只有第一个候选闭合行参与判定：若它围起来的区间不是 YAML，这段文本就不是 frontmatter，按正文保留。 */
const frontmatterEnd = (lines: readonly RawLine[]): number => {
  if (lines[0]?.text.trim() !== FRONTMATTER_DELIMITER) return 0;
  const limit = Math.min(lines.length, FRONTMATTER_MAX_LINES);
  for (let index = 1; index < limit; index += 1) {
    if (lines[index].text.trim() !== FRONTMATTER_DELIMITER) continue;
    const body = lines.slice(1, index).map((line) => line.text).join("\n");
    return parsesAsYamlMapping(body) ? index + 1 : 0;
  }
  return 0;
};

/** frontmatter 是 YAML **映射**：边界与语义都由解析器证明，而不是由文本里的字符组合证明。
 *  解析失败（含重复键）或解析结果不是映射（例如开头是水平线、中间夹着普通正文的
 *  `--- … ---` 会被 YAML 当成多行标量）⇒ 不认作 frontmatter，宁可把这段文本留给指纹。
 *  空区间是合法的空 frontmatter（js-yaml 对空输入抛"expected a document"，故先判空）。 */
const parsesAsYamlMapping = (text: string): boolean => {
  if (text.trim().length === 0) return true;
  try {
    const value: unknown = load(text);
    return value === undefined || value === null || (typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
};

const fenceOpener = (line: string): FenceOpener | null => {
  const match = FENCE_OPEN.exec(line);
  if (!match) return null;
  const marker = match[2];
  // CommonMark：反引号围栏的 info string 不得含反引号 ⇒ 行内出现的 ``` 永远只是正文。
  if (marker.startsWith("`") && (match[3] ?? "").includes("`")) return null;
  return { char: marker[0], length: marker.length };
};

const closesFence = (line: string, opener: FenceOpener): boolean => {
  const trimmed = line.replace(/^ {0,3}/u, "");
  let count = 0;
  while (count < trimmed.length && trimmed[count] === opener.char) count += 1;
  return count >= opener.length && trimmed.slice(count).trim() === "";
};

const backtickRunAt = (line: string, index: number): number => {
  let run = 0;
  while (line[index + run] === "`") run += 1;
  return run;
};

/** 行内代码片段（CommonMark inline code span）：长度相同的反引号串成对。
 *  只配对**同一行内**的反引号串——未配对的反引号不做跨行解释，因此不可能吞掉后续文档结构。 */
const inlineCodeSpans = (line: string): readonly Span[] => {
  if (!line.includes("`")) return [];
  const spans: Span[] = [];
  let index = 0;
  while (index < line.length) {
    const run = backtickRunAt(line, index);
    if (run === 0) {
      index += 1;
      continue;
    }
    let closer = index + run;
    while (closer < line.length) {
      const candidate = backtickRunAt(line, closer);
      if (candidate === run) break;
      closer += candidate === 0 ? 1 : candidate;
    }
    if (closer >= line.length) {
      index += run;
      continue;
    }
    spans.push({ from: index, to: closer + run });
    index = closer + run;
  }
  return spans;
};

/** 该行 `from` 之后第一个**不在行内代码片段里**的 `<!--`；没有则 -1。 */
const nextCommentStart = (line: string, from: number, codeSpans: readonly Span[]): number => {
  let index = line.indexOf("<!--", from);
  while (index !== -1) {
    if (!codeSpans.some((span) => index >= span.from && index < span.to)) return index;
    index = line.indexOf("<!--", index + 4);
  }
  return -1;
};

/** 把已证明的注释区间应用到原文：一次双指针遍历（区间有序且互不重叠）同时产出
 *  每行去注释文本与整篇去注释文本。区间内部（含跨行注释吞掉的行尾）逐字节删除，
 *  区间之外逐字节保留——因此没有"行尾归一化"这类附带语义变化。
 *  逐行 × 逐区间的朴素写法的复杂度是 O(行数 × 区间数)，必须在同一遍里消化两个有序序列。 */
const applyCommentSpans = (
  content: string,
  raw: readonly RawLine[],
  spans: readonly Span[],
): { readonly texts: readonly string[]; readonly withoutComments: string } => {
  const texts: string[] = [];
  let withoutComments = "";
  let spanIndex = 0;
  let emitted = 0;
  for (const line of raw) {
    const lineEnd = line.start + line.text.length;
    let text = "";
    let cursor = line.start;
    while (spanIndex < spans.length && spans[spanIndex].from < lineEnd) {
      const span = spans[spanIndex];
      if (span.to <= cursor) {
        spanIndex += 1;
        continue;
      }
      const from = Math.max(span.from, cursor);
      text += line.text.slice(cursor - line.start, from - line.start);
      withoutComments += content.slice(emitted, from);
      cursor = Math.min(span.to, lineEnd);
      emitted = cursor;
      if (span.to <= lineEnd) {
        spanIndex += 1;
        continue;
      }
      break;
    }
    text += line.text.slice(cursor - line.start);
    withoutComments += content.slice(emitted, lineEnd);
    emitted = lineEnd;
    const eolEnd = lineEnd + line.eol.length;
    const open = spans[spanIndex];
    // 行尾只有在仍处于某个跨行区间内时才被删除（注释区间可以吞掉换行）。
    if (open !== undefined && open.from < eolEnd && open.to > lineEnd) {
      emitted = Math.min(open.to, eolEnd);
    } else {
      withoutComments += content.slice(emitted, eolEnd);
      emitted = eolEnd;
    }
    texts.push(text);
  }
  if (emitted < content.length) withoutComments += content.slice(emitted);
  return { texts, withoutComments };
};

/** 一次 O(n) 行扫描得到：结构化分类、去注释文本、以及"证明不了"的两个标志。 */
export const scanMarkdown = (content: string): MarkdownScan => {
  const raw = splitRawLines(content);
  const bodyStart = frontmatterEnd(raw);
  const inFence = raw.map(() => false);
  const commentSpans: Span[] = [];
  let inComment = false;
  let commentStart = 0;
  let unterminatedFence = false;
  // 一次"找不到闭围栏"的搜索覆盖到文件末尾。未闭合的开围栏按 Markdown 语义已经吞掉其后内容，
  // 因此其后不再做局部证明（结果同样是"保留文本 + 置位 unterminatedFence"），
  // 这条记忆让扫描保持 O(n)，不会退化成每个开围栏一次全文搜索。
  let closersExhausted = false;

  for (let index = bodyStart; index < raw.length; index += 1) {
    const line = raw[index];
    // 围栏定界行必须整行成立；已经处于注释内的行不可能是围栏定界行。
    const opener = inComment ? null : fenceOpener(line.text);
    if (opener && !closersExhausted) {
      let closer = -1;
      for (let probe = index + 1; probe < raw.length; probe += 1) {
        if (closesFence(raw[probe].text, opener)) {
          closer = probe;
          break;
        }
      }
      if (closer === -1) {
        closersExhausted = true;
        unterminatedFence = true;
      } else {
        for (let fenceLine = index; fenceLine <= closer; fenceLine += 1) inFence[fenceLine] = true;
        index = closer;
        continue;
      }
    }
    // 围栏内的行不参与注释扫描：那里的 `<!--` 是代码。
    if (inFence[index]) continue;
    const codeSpans = inlineCodeSpans(line.text);
    let cursor = 0;
    while (cursor <= line.text.length) {
      if (inComment) {
        const end = line.text.indexOf("-->", cursor);
        if (end === -1) break;
        commentSpans.push({ from: commentStart, to: line.start + end + 3 });
        inComment = false;
        cursor = end + 3;
        continue;
      }
      const start = nextCommentStart(line.text, cursor, codeSpans);
      if (start === -1) break;
      commentStart = line.start + start;
      inComment = true;
      cursor = start + 4;
    }
  }

  const spans = [...commentSpans].sort((left, right) => left.from - right.from);
  const applied = applyCommentSpans(content, raw, spans);
  const lines: MarkdownLine[] = raw.map((_line, index) => ({
    text: applied.texts[index],
    inFence: inFence[index],
    frontmatter: index < bodyStart,
  }));
  return {
    lines,
    withoutComments: applied.withoutComments,
    unterminatedFence,
    // 未闭合的注释没有产生任何 span（只删成对的注释），文本因此被完整保留。
    unterminatedComment: inComment,
  };
};
