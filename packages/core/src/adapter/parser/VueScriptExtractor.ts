// .vue SFC script block 提取：返回 `<script>`（含 `<script setup>`）块内的 JS/TS 文本。
// 保留行号偏移：提取文本按原文件行号对齐（空行占位），使 AST 行号与源文件一致。
// 无 script block 时返回 null（模板/样式仅 SFC 视为无逻辑）。

const SCRIPT_OPEN = /<script\b[^>]*>/g;

/** 提取 <script> 块文本（保留行号占位）。lang="ts" 时按 typescript 语义，否则按 javascript。 */
export const extractVueScriptBlock = (source: string): { code: string; language: "typescript" | "javascript"; startLine: number } | null => {
  let match: RegExpExecArray | null;
  SCRIPT_OPEN.lastIndex = 0;
  while ((match = SCRIPT_OPEN.exec(source)) !== null) {
    const openTag = match[0];
    // 跳过 <script src="...">（外部脚本，无内联逻辑）
    if (/\bsrc\s*=/.test(openTag)) continue;
    const startIndex = match.index;
    const contentStart = startIndex + openTag.length;
    const closeMatch = source.indexOf("</script>", contentStart);
    if (closeMatch === -1) continue;
    const content = source.slice(contentStart, closeMatch).replace(/^\n+/, "");
    const startLine = source.slice(0, contentStart).split("\n").length;
    const language = /\blang\s*=\s*["']ts["']/.test(openTag) ? "typescript" : "javascript";
    // 行号对齐：script 内容前填充空行，使提取文本首行与原文件 script 起始行对齐。
    const prefix = "\n".repeat(startLine - 1);
    return { code: `${prefix}${content}`, language, startLine };
  }
  return null;
};
