// 审计 C-1 回归：record 模板的完整性判定必须按 Markdown 结构剥注释——
// 围栏内的 `<!-- … -->` 是正文（不能被剥成空），围栏或注释未闭合时结构不可判定，
// 必须 fail-closed（判为未填写），不得静默放行。
import { describe, expect, it } from "vitest";
import { isUnfilledRecordDocument, stripHtmlComments } from "../../src/document-store/DocumentFill";

const ORIGIN = "来源: openarch docs record";
const REQUIRED = ["## 背景", "## 分析", "## 应对", "## 教训"] as const;

const template = (bodies: Readonly<Record<string, string>>): string =>
  [ORIGIN, "", ...REQUIRED.map((heading) => `${heading}\n${bodies[heading] ?? ""}`)].join("\n\n");

describe("stripHtmlComments（结构性剥离，不是全文 `[\s\S]*?` 配对）", () => {
  it("removes only proven comment spans and preserves everything else byte-for-byte", () => {
    expect(stripHtmlComments("a<!-- 注释 -->b")).toBe("ab");
    expect(stripHtmlComments("a<!-- 注释 -->\r\nb")).toBe("a\r\nb");
    expect(stripHtmlComments("<!-- 第一行\n第二行 -->尾")).toBe("尾");
  });

  it("keeps `<!--` inside a fenced code block or an inline code span", () => {
    expect(stripHtmlComments("```\n<!-- 不剥 -->\n```")).toBe("```\n<!-- 不剥 -->\n```");
    expect(stripHtmlComments("`<!-- 不剥 -->`")).toBe("`<!-- 不剥 -->`");
    // 未闭合的注释不删除任何文本（只删成对区间）。
    expect(stripHtmlComments("a<!-- 未闭合")).toBe("a<!-- 未闭合");
  });
});

describe("isUnfilledRecordDocument（结构性判定 + fail-closed）", () => {
  it("still flags a generated template whose sections only carry guidance comments", () => {
    const guidance = template(Object.fromEntries(REQUIRED.map((heading) => [heading, "<!-- 必填：填写结论 -->"])));
    expect(isUnfilledRecordDocument(guidance)).toBe(true);
    // 对照组：填上真实内容后不再阻断。
    expect(isUnfilledRecordDocument(template(Object.fromEntries(REQUIRED.map((heading) => [heading, "真实结论。"]))))).toBe(false);
  });

  it("counts fenced content as real content instead of a stripped-away comment", () => {
    const filled = [
      ORIGIN, "",
      "## 背景", "围栏里的注释是正文：", "", "```markdown", "<!-- 不剥 -->", "```", "",
      "## 分析", "真实分析。", "",
      "## 应对", "已修复。", "",
      "## 教训", "围栏内的 `<!-- -->` 不再是注释。",
    ].join("\n");
    expect(isUnfilledRecordDocument(filled)).toBe(false);
  });

  it("does not treat a `#` inside a fence as a section heading", () => {
    const fencedHeadings = [
      ORIGIN, "",
      "## 背景", "示例：", "", "```markdown", "## 分析", "待填写", "```", "",
      "## 分析", "真实分析。", "",
      "## 应对", "已修复。", "",
      "## 教训", "示例里的标题不算小节。",
    ].join("\n");
    expect(isUnfilledRecordDocument(fencedHeadings)).toBe(false);
  });

  it("fails closed when a code fence is never closed", () => {
    const unclosed = [ORIGIN, "", "## 背景", "已填写。", "", "```", "## 分析", "已填写。", "## 应对", "已填写。", "## 教训", "已填写。"].join("\n");
    expect(isUnfilledRecordDocument(unclosed)).toBe(true);
  });

  it("fails closed when an HTML comment is never closed", () => {
    const unclosedComment = [ORIGIN, "", "## 背景", "已填写。", "<!-- 忘记闭合"].join("\n");
    expect(isUnfilledRecordDocument(unclosedComment)).toBe(true);
  });

  it("keeps non-record documents out of the predicate", () => {
    expect(isUnfilledRecordDocument("普通文档\n\n## 背景\n")).toBe(false);
  });
});

// 审计回归：`d7c3cea6` 之前生成器写 `来源: openarch record`，本判据诞生时只认
// `openarch docs record`，共享文档库的历史记录因此整批落在判定人口之外。两种来源行
// 都是生成器产出，必须同等纳入；而手写来源（`openarch dogfood`）不得被顺手纳入。
describe("isUnfilledRecordDocument（provenance 格式迁移兼容）", () => {
  const LEGACY_ORIGIN = "来源: openarch record";
  const legacyTemplate = (bodies: Readonly<Record<string, string>>): string =>
    [LEGACY_ORIGIN, "", ...REQUIRED.map((heading) => `${heading}\n${bodies[heading] ?? ""}`)].join("\n\n");
  const allBodies = (body: string): Readonly<Record<string, string>> => Object.fromEntries(REQUIRED.map((heading) => [heading, body]));

  it("flags an empty legacy template (`来源: openarch record`) instead of silently skipping it", () => {
    const empty = [
      LEGACY_ORIGIN, "",
      "## 背景", "<!-- 必填：什么改动触发了这条记录？ -->", "",
      "## 分析", "<!-- 必填：为什么触发规则？ -->", "",
      "## 应对", "<!-- 必填：做了什么决定？ -->", "",
      "## 教训", "<!-- 必填：下次遇到类似情况怎么处理？ -->", "",
    ].join("\n");
    expect(isUnfilledRecordDocument(empty)).toBe(true);
    // 旧格式的英文变体与占位正文（引导注释被剥掉后只剩空行 / 裸占位符）。
    expect(isUnfilledRecordDocument(["Source: openarch record", "", "## Background", "<!-- REQUIRED -->", "", "## Analysis", "TBD", "## Response", "待补充", "## Lessons", ""].join("\n"))).toBe(true);
    expect(isUnfilledRecordDocument(legacyTemplate(allBodies("")))).toBe(true);
  });

  it("accepts a filled legacy template", () => {
    expect(isUnfilledRecordDocument(legacyTemplate(allBodies("真实结论。")))).toBe(false);
    // 当前格式（带 `docs`）仍按原语义判定，未因兼容旧格式而放宽。
    expect(isUnfilledRecordDocument(template(allBodies("真实结论。")))).toBe(false);
    expect(isUnfilledRecordDocument(template(allBodies("")))).toBe(true);
  });

  it("keeps hand-written provenance variants out of the population", () => {
    // `openarch dogfood` 是手工来源，正文用 `观察/应对/边界` 而非必填标题；
    // 纳入它会改变人口语义，属另一个决定。
    const dogfood = ["# 狗粮记录", "来源: OpenArch dogfood", "", "## 观察", "看到了什么。", "", "## 应对", "做了什么。", "", "## 边界", "哪里不适用。"].join("\n");
    expect(isUnfilledRecordDocument(dogfood)).toBe(false);
    // 来源行不是独占整行时不算 provenance；`docs` 也不是通配。
    expect(isUnfilledRecordDocument(["来源: openarch record（升级前）", "", "## 背景", ""].join("\n"))).toBe(false);
    expect(isUnfilledRecordDocument(["来源: openarch docs records", "", "## 背景", ""].join("\n"))).toBe(false);
  });
});

// 审计回归：必填小节此前按标题精确匹配，作者给标题加末尾括号注解（日常可达）就会让
// 该小节**静默**退出判定。规范化只容忍尾部差异，不做包含匹配。
describe("isUnfilledRecordDocument（必填标题的尾部括号注解）", () => {
  const withHeadings = (headings: Readonly<Record<string, string>>, body: string): string =>
    [ORIGIN, "", ...REQUIRED.map((heading) => `${headings[heading] ?? heading}\n${body}`)].join("\n\n");

  it("keeps a required section with a trailing annotation in the population", () => {
    // 真实的第三篇记录写法：`## 教训（通用经验——可跨项目复用）`。
    expect(isUnfilledRecordDocument(withHeadings({ "## 教训": "## 教训（通用经验——可跨项目复用）" }, ""))).toBe(true);
    expect(isUnfilledRecordDocument(withHeadings({ "## 教训": "## 教训（通用经验）" }, ""))).toBe(true);
    // 中英文括号、内部空白、多个注解、全角空格混用都只算尾部差异。
    expect(isUnfilledRecordDocument(withHeadings({ "## 分析": "## 分析 ( why )" }, ""))).toBe(true);
    expect(isUnfilledRecordDocument(withHeadings({ "## 背景": "## 背景（一）（二）" }, ""))).toBe(true);
    // 对照：同样带注解但正文填好 ⇒ 不再判定。
    expect(isUnfilledRecordDocument(withHeadings({ "## 教训": "## 教训（通用经验——可跨项目复用）" }, "真实结论。"))).toBe(false);
  });

  it("does not widen matching to containment", () => {
    // 反例必须隔离：其余三个必填小节填好，只有 `教训` 是空正文的变体——
    // 若匹配被放宽成前缀/包含，这条就会被判为未填写。
    const lessonsVariant = (heading: string, lessonsBody: string): string => [
      ORIGIN, "",
      "## 背景", "真实结论。", "",
      "## 分析", "真实结论。", "",
      "## 应对", "真实结论。", "",
      heading, lessonsBody,
    ].join("\n");
    // `教训与反思` 不是 `教训`：注解之外的前缀/包含关系不得被容忍。
    expect(isUnfilledRecordDocument(lessonsVariant("## 教训与反思", ""))).toBe(false);
    expect(isUnfilledRecordDocument(lessonsVariant("## 教训记录（通用经验）", ""))).toBe(false);
    expect(isUnfilledRecordDocument(lessonsVariant("## 教训-[通用经验]", ""))).toBe(false);
    expect(isUnfilledRecordDocument(lessonsVariant("## 复盘教训", ""))).toBe(false);
    // 注解在标题中间（不是尾部）同样不受容忍。
    expect(isUnfilledRecordDocument(lessonsVariant("## 教训（通用经验）与反思", ""))).toBe(false);
    // 对照组：同样的空正文，标题是必填的 `教训` ⇒ 判为未填写（证明反例不是空判据）。
    expect(isUnfilledRecordDocument(lessonsVariant("## 教训", ""))).toBe(true);
    expect(isUnfilledRecordDocument(lessonsVariant("## 教训（通用经验）", ""))).toBe(true);
  });

  it("still treats a `#` inside a fence as code, not as a heading variant", () => {
    const fencedVariant = [
      ORIGIN, "",
      "## 背景", "示例：", "", "```markdown", "## 教训（通用经验）", "待填写", "```", "已填写。", "",
      "## 分析", "真实分析。", "",
      "## 应对", "已修复。", "",
      "## 教训", "示例里的标题不算小节，包括带注解的变体。",
    ].join("\n");
    expect(isUnfilledRecordDocument(fencedVariant)).toBe(false);
  });
});
