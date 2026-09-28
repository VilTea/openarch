// 审计 C-8 / C-1 回归：块级指纹删除重复归一化后必须逐位不变；
// Markdown 归一化必须按**结构**（围栏 / 行内代码 / frontmatter / 未闭合）判定边界，
// 而不是靠 `[\s\S]*?` 猜字符组合。
import { describe, expect, it } from "vitest";
import { codeIndexedDocument, indexedDocument } from "../../src/document-store/DocumentFingerprint";
import { FRONTMATTER_MAX_LINES, scanMarkdown } from "../../src/document-store/MarkdownStructure";

const CODE_FIXTURE = [
  'import { readFileSync } from "node:fs";',
  "",
  "export const load = (path: string): string => {",
  '  const raw = readFileSync(path, "utf8"); // 读取全部内容',
  '  return raw.trim().replace(/\\r?\\n/gu, "\\n");',
  "};",
  "",
  "export const twice = (value: number): number => value * 2;",
].join("\n");

/** 改动前用旧实现（`codeIndexedDocument` 内部调用两次 `codeFeaturesOf`）捕获的同一输入指纹。
 *  删除重复调用是零语义变更，因此这两个常量不允许漂移。 */
const GOLDEN_SIMHASH = "481b6d7d00cf4800";
const GOLDEN_MINHASH = "1281233352,1001382821,1190811754,770438247,1466567220,2444278853,507945366,1141011256,1270531312,606786797,1643938322,3129187564,850837948,900766910,105628862,2726755187,736200376,400771234,1573699190,307669220,1078795460,987619393,388300870,1314532651,3337984992,183960025,1974202382,2588345543,72844524,1697614285,769013491,143740211,1757931389,655122821,2185245514,1483271540,2873733969,468741062,1211194219,2491703512,322876488,860762986,2094109170,401782583,403747484,188719833,52160798,1714544016,2874539672,271287746,1514250426,1427600132,876163524,589723937,406445243,1310906088,700829248,2740075066,1571850018,1441806095,2172327964,359252553,1396476942,17582816";

describe("codeIndexedDocument（审计 C-8：同一文本只归一化一次）", () => {
  it("keeps the pre-dedup fingerprint bit-for-bit", () => {
    const document = codeIndexedDocument("fixture.ts", CODE_FIXTURE);
    expect(document.simHash).toBe(GOLDEN_SIMHASH);
    expect(document.minHash.join(",")).toBe(GOLDEN_MINHASH);
    // 同一输入重复调用，结果逐位相同（特征集合被复用，而不是两次独立求值）。
    expect(codeIndexedDocument("fixture.ts", CODE_FIXTURE)).toEqual(document);
  });

  it("derives the fingerprint from content only, and still separates different inputs", () => {
    expect(codeIndexedDocument("a.ts", CODE_FIXTURE).simHash).toBe(codeIndexedDocument("b.ts", CODE_FIXTURE).simHash);
    const changed = `${CODE_FIXTURE}\nexport const third = (value: number): number => value * 3;`;
    expect(codeIndexedDocument("fixture.ts", changed).simHash).not.toBe(GOLDEN_SIMHASH);
  });
});

describe("indexedDocument（审计 C-1：结构性 Markdown 边界）", () => {
  it("keeps an HTML comment that lives inside a fenced code block as code", () => {
    const fenced = ["intro", "```", "<!-- 不剥 -->", "```", "outro"].join("\n");
    const scan = scanMarkdown(fenced);
    expect(scan.lines[2]).toMatchObject({ text: "<!-- 不剥 -->", inFence: true });
    expect(scan.unterminatedComment).toBe(false);
    // 围栏区间被证明是代码 ⇒ 指纹与"只有正文"的文档相同。
    expect(indexedDocument("a.md", fenced).simHash).toBe(indexedDocument("a.md", "intro\noutro").simHash);
    // 围栏内未闭合的 `<!--` 也不会被当成未闭合注释（旧实现会从它开始剥到文件尾）。
    expect(scanMarkdown(["intro", "```", "<!--", "code", "```", "outro"].join("\n")).unterminatedComment).toBe(false);
  });

  it("does not read an inline ``` as a fence delimiter", () => {
    const inline = ["inline ```not a fence``` in prose", "```", "code", "```", "tail"].join("\n");
    expect(scanMarkdown(inline).lines.map((line) => line.inFence)).toEqual([false, true, true, true, false]);
  });

  it("strips frontmatter only when the document head is a parsed YAML mapping", () => {
    const frontmatter = "---\ntitle: 记录\n---\n# 正文\n\nbody";
    // 标题取自归一化后的文本（空白已折叠），frontmatter 不在其中。
    expect(indexedDocument("a.md", frontmatter).title).toBe("正文 body");
    // 空 frontmatter 也是合法的 YAML（解析结果为 undefined）。
    expect(scanMarkdown("---\n---\n# x").lines.filter((line) => line.frontmatter)).toHaveLength(2);
    // 审计 C-1 反例：开头是水平线、中间夹真实正文时，正文不再被当 frontmatter 删除。
    const horizontalRule = "---\n这是一段真实正文，不是 YAML 映射。\n\n---\n\n# 后面的标题";
    expect(scanMarkdown(horizontalRule).lines.some((line) => line.frontmatter)).toBe(false);
    expect(indexedDocument("a.md", horizontalRule).simHash).not.toBe(indexedDocument("a.md", "# 后面的标题").simHash);
    // frontmatter 只在文档开头：正文里的成对 `---` 不参与判定。
    expect(scanMarkdown("# 标题\n\n---\n\n内容\n\n---\n\n尾").lines.some((line) => line.frontmatter)).toBe(false);
    // 有界：闭合定界符落在界外 ⇒ 按正文处理，不猜边界。
    const beyondBound = ["---", ...Array.from({ length: FRONTMATTER_MAX_LINES }, () => "key: value"), "---", "# 尾"].join("\n");
    expect(scanMarkdown(beyondBound).lines.some((line) => line.frontmatter)).toBe(false);
  });

  it("retains an unclosed fence instead of producing a clean-looking fingerprint", () => {
    const unclosed = ["prose line", "```", "leaked code line", "more code"].join("\n");
    const scan = scanMarkdown(unclosed);
    expect(scan.unterminatedFence).toBe(true);
    // 未证明闭合 ⇒ 一行都不标记为围栏，文本全部保留。
    expect(scan.lines.every((line) => !line.inFence)).toBe(true);
    expect(indexedDocument("a.md", unclosed).simHash).not.toBe(indexedDocument("a.md", "prose line").simHash);
  });

  it("never removes text for an unclosed HTML comment", () => {
    const unclosed = "before <!-- never closed\nplain text stays";
    const scan = scanMarkdown(unclosed);
    expect(scan.unterminatedComment).toBe(true);
    expect(scan.withoutComments).toBe(unclosed);
    expect(scan.lines[1]).toMatchObject({ text: "plain text stays" });
  });
});
