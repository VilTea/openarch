// .vue SFC script block 提取：返回 `<script>`（含 `<script setup>`）块内的 JS/TS 文本。
// 保留行号偏移：提取文本按原文件行号对齐（空行占位），使 AST 行号与源文件一致。
// 无 script block 时返回 null（模板/样式仅 SFC 视为无逻辑）。
//
// 为什么不用"整文件正则 + 裸 indexOf("</script>")"（审计 D3）：
//   模板里出现 `{{ "<script>" }}` 时，`<script` 扫描会命中插值字符串，而裸 indexOf 找到的是真正的闭合标签，
//   于是把模板 HTML 当 JS 送进 tree-sitter，污染 parseVue 的 loc / 分支 / 导入图（baseline 也随之被污染）。
// 为什么不用现成的 Vue/HTML 语法（tree-sitter）：
//   随包发布的 grammar 只有 go/java/python/rust/typescript（packages/core/grammars），
//   真 Vue grammar 会改变既有"提取 script 再按 TS/JS 解析 + 空行占位对齐"的 loc 约定（见 TsStrategy.parseVue），
//   迁移面远大于收益；提取本身也是解析的前置步骤，拿不到解析结果可用。
// 因此改为单遍手写扫描（O(n)、无回溯），只跳过三类**可从语法证明**的上下文：
//   1. HTML 注释 `<!-- … -->`：HTML 注释不可嵌套，遇 `-->` 即结束，无需回溯；
//   2. 模板插值 `{{ … }}`：插值内容是 JS 表达式，按 JS 的引号/注释规则跳过，
//      字符串里的 `}}` 不会提前收尾，`{{ "<script>" }}` 也不会被当成标签；
//   3. 标签内部：引号包裹的属性值里的 `>` 与 `</script>` 不参与边界判定（属性不是元素）。
// 闭合标签本身不需要注释/字符串感知：按 HTML 规范 `<script>`/`<style>` 是 raw text 元素，
// 其内容在第一个 `</script`（后接空白、`/`、`>` 或文件结尾）处结束——这正是浏览器与 Vue SFC 编译器的行为。
// 已声明边界：模板里的自定义块（如 `<i18n>`）按标记扫描，不做 raw text 跳过；
// 其内容里若出现 `<script` 字面量会被当作块边界（既有的正则实现同样如此，不是本次修复引入的退化）。

const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

const isSpaceCode = (code: number): boolean =>
  code === 32 /* space */ || code === 9 /* tab */ || code === 10 /* lf */ || code === 13 /* cr */ || code === 12 /* ff */;

const isAsciiLetterCode = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

const isTagNameCode = (code: number): boolean => isAsciiLetterCode(code) || (code >= 48 && code <= 57) || code === 45 /* - */;

/** ASCII 大小写无关的名字比较（HTML 标签名不区分大小写）。 */
const matchesName = (source: string, start: number, name: string): boolean => {
  if (start + name.length > source.length) return false;
  for (let offset = 0; offset < name.length; offset += 1) {
    const code = source.charCodeAt(start + offset);
    if (code !== name.charCodeAt(offset) && (code | 0x20) !== name.charCodeAt(offset)) return false;
  }
  return true;
};

/** JS 引号字面量（插值表达式内）：处理转义；单/双引号不能跨行（JS 词法），未闭合即止。 */
const skipJsQuoted = (source: string, start: number): number => {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === "\n" && quote !== "`") return index + 1;
    index += 1;
  }
  return source.length;
};

/** HTML 属性值（标签内）：HTML 没有反斜杠转义，只找配对的引号；属性值可以跨行。 */
const skipAttributeValue = (source: string, start: number): number => {
  const quote = source[start];
  const end = source.indexOf(quote, start + 1);
  return end === -1 ? source.length : end + 1;
};

/** 跳过 `{{ … }}`：按 JS 的字符串与注释规则前进，避免表达式里的 `}}` 提前收尾。 */
const skipInterpolation = (source: string, start: number): number => {
  let index = start + 2;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipJsQuoted(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === "}" && source[index + 1] === "}") return index + 2;
    index += 1;
  }
  return source.length;
};

interface ParsedTag {
  readonly name: string;
  readonly closing: boolean;
  readonly text: string;
  /** `>` 之后的下标（标签内容起点）。 */
  readonly end: number;
}

/** 从 `<` 读一个标签；`<` 后不是标签名（模板文本里的 `a < b`、`1 <2`）或标签未闭合时返回 null。 */
const readTag = (source: string, start: number): ParsedTag | null => {
  let index = start + 1;
  const closing = source[index] === "/";
  if (closing) index += 1;
  if (!isAsciiLetterCode(source.charCodeAt(index))) return null;
  const nameStart = index;
  while (index < source.length && isTagNameCode(source.charCodeAt(index))) index += 1;
  const name = source.slice(nameStart, index).toLowerCase();
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'") {
      index = skipAttributeValue(source, index);
      continue;
    }
    if (char === ">") return { name, closing, text: source.slice(start, index + 1), end: index + 1 };
    index += 1;
  }
  return null;
};

/** raw text 元素的内容在第一个 `</name`（后接空白、`/`、`>` 或文件结尾）处结束。 */
const readRawText = (source: string, from: number, name: string): { contentEnd: number; end: number } | null => {
  for (let index = from; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 60 /* < */ || source.charCodeAt(index + 1) !== 47 /* / */) continue;
    const nameStart = index + 2;
    if (!matchesName(source, nameStart, name)) continue;
    const boundary = source.charCodeAt(nameStart + name.length);
    if (!Number.isNaN(boundary) && boundary !== 62 /* > */ && boundary !== 47 /* / */ && !isSpaceCode(boundary)) continue;
    const close = source.indexOf(">", nameStart + name.length);
    return { contentEnd: index, end: close === -1 ? source.length : close + 1 };
  }
  return null;
};

/** 提取契约：`null` = 没有可证明的内联 script 块；`startLine` = script 内容在原文件中的起始行。
 *  `code` 用空行占位对齐到 `startLine`，因此提取文本的行号与原文件一致（见 TsStrategy.parseVue）。 */
export interface VueScriptBlock {
  readonly code: string;
  readonly language: "typescript" | "javascript";
  readonly startLine: number;
}

/** 当前位置的形态——扫描器的核心概念，因此显式命名，而不是把三类跳过写成一串嵌套 `if`。
 *  判定顺序与"最左优先"一致：注释 `<!--` 先于标签（`<!` 不是标签名），
 *  插值 `{{` 与 `<` 互斥，其余字符是模板文本。 */
type SourcePosition =
  | { readonly kind: "comment"; readonly end: number }
  | { readonly kind: "interpolation"; readonly end: number }
  | { readonly kind: "tag"; readonly tag: ParsedTag }
  | { readonly kind: "text" };

/** HTML 注释不可嵌套，遇 `-->` 即结束，无需回溯（三类可证明跳过上下文之一）。 */
const readComment = (source: string, start: number): number => {
  const end = source.indexOf("-->", start + 4);
  return end === -1 ? source.length : end + 3;
};

const classifyPosition = (source: string, index: number): SourcePosition => {
  if (source.startsWith("<!--", index)) return { kind: "comment", end: readComment(source, index) };
  if (source.startsWith("{{", index)) return { kind: "interpolation", end: skipInterpolation(source, index) };
  if (source[index] !== "<") return { kind: "text" };
  const tag = readTag(source, index);
  // `<` 后不是标签名（模板文本里的 `a < b`、`1 <2`）或标签未闭合：按普通文本前进一个字符。
  return tag === null ? { kind: "text" } : { kind: "tag", tag };
};

/** `<script>` 块的扫描结论：要么取到内联块（`block`），要么这个概念不成立——外部脚本
 *  （`<script src>`）无内联逻辑，未闭合的 `<script>` 不猜内容边界。两种情况下都从 `end` 继续：
 *  **必须吃掉整段 raw text**，否则 `</script>` 与后续标签会被重新当成块起始，
 *  改变"哪个块算第一个候选块"的判定（与旧实现一致）。 */
interface ScriptTagScan {
  readonly block: VueScriptBlock | null;
  readonly end: number;
}

const scanScriptTag = (source: string, tag: ParsedTag): ScriptTagScan => {
  const raw = readRawText(source, tag.end, tag.name);
  const end = raw === null ? tag.end : raw.end;
  // 判据是标签文本上的 `\bsrc\s*=`：只要出现 src 属性就是外部脚本，不看属性值形态。
  if (/\bsrc\s*=/.test(tag.text) || raw === null) return { block: null, end };
  const content = source.slice(tag.end, raw.contentEnd).replace(/^\n+/, "");
  const startLine = source.slice(0, tag.end).split("\n").length;
  const language = /\blang\s*=\s*["']ts["']/.test(tag.text) ? "typescript" : "javascript";
  // 行号对齐：script 内容前填充空行，使提取文本首行与原文件 script 起始行对齐。
  return { block: { code: `${"\n".repeat(startLine - 1)}${content}`, language, startLine }, end };
};

/** `<style>` 的 CSS 里 `<script` 不是标签，因此整块跳过其 raw text；找不到闭合标签时退回标签之后。 */
const skipRawTextElement = (source: string, tag: ParsedTag): number =>
  readRawText(source, tag.end, tag.name)?.end ?? tag.end;

/** 单遍步进：返回下一个扫描下标，或（内联 script 块已证明时）返回提取结果。
 *  raw text 元素的三种形态各有自己的边界规则：`<style>` 整块跳过；`<script>` 交给 `scanScriptTag`
 *  （内联块 / 外部脚本 / 未闭合）；闭合标签与非 raw text 元素只跳过标签本身。 */
const stepScan = (source: string, index: number): number | VueScriptBlock => {
  const position = classifyPosition(source, index);
  if (position.kind === "comment" || position.kind === "interpolation") return position.end;
  if (position.kind === "text") return index + 1;
  if (position.tag.closing) return position.tag.end;
  const { tag } = position;
  if (tag.name === "style") return skipRawTextElement(source, tag);
  if (tag.name !== "script") return tag.end;
  const scan = scanScriptTag(source, tag);
  return scan.block === null ? scan.end : scan.block;
};

/** 提取 <script> 块文本（保留行号占位）。lang="ts" 时按 typescript 语义，否则按 javascript。
 *
 *  结构（校准 2026-09-26）：原先三类跳过上下文与提取判定全部集中在本函数（单函数加权分支 6.0、
 *  嵌套深度 4 层），本地负担 crl_local=0.483 触发了"核心模块局部负担偏高"。现在按"定位 → 分类 →
 *  步进"分成 `classifyPosition` / `stepScan` / `scanScriptTag`：本函数只保留扫描循环与分派。 */
export const extractVueScriptBlock = (source: string): VueScriptBlock | null => {
  let index = 0;
  while (index < source.length) {
    const step = stepScan(source, index);
    if (typeof step !== "number") return step;
    index = step;
  }
  return null;
};
