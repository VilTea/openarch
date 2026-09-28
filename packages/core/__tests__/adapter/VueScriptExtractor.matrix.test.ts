// `extractVueScriptBlock` 的**行为特征矩阵**（锁行为再动结构）。
//
// 每条期望值都来自**改动前实现的真实输出**（临时探针逐例打印 `JSON.stringify` 后原样抄入，探针已删除）：
//   npx tsx .vue-oracle-probe.mts
// 矩阵的用途：重构 `VueScriptExtractor.ts` 的局部复杂度时，提取契约必须逐字不变——
// 三处跳过上下文（HTML 注释 / `{{ }}` 插值 / 标签内部）、raw text 闭合规则、
// `lang` 判定、`startLine` 与空行占位、`null` 返回、以及已声明边界（自定义块不按 raw text 跳过）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractVueScriptBlock } from "../../src/adapter/parser/VueScriptExtractor";

const fixture = (name: string): string => readFileSync(resolve(__dirname, "..", "..", "fixtures", name), "utf8");

/** 提取结果的可比较形状（只含契约字段，便于整表钉住）。 */
type Extraction = { code: string; language: "typescript" | "javascript"; startLine: number } | null;

const probe = (source: string): Extraction => {
  const result = extractVueScriptBlock(source);
  return result === null ? null : { code: result.code, language: result.language, startLine: result.startLine };
};

interface Case {
  readonly name: string;
  readonly input: string;
  /** 改动前实现的真实输出（原样，不是推导值）。 */
  readonly expected: Extraction;
}

const CASES: readonly Case[] = [
  { name: "no script at all", input: `<template><div/></template>`, expected: null },
  // 外部脚本没有内联逻辑 ⇒ null（必须整块跳过，不能把 `</script>` 当成闭合后继续找）。
  { name: "external script src", input: `<script src="./x.js"></script>`, expected: null },
  { name: "plain script", input: `<script>export default {};</script>`, expected: { code: "export default {};", language: "javascript", startLine: 1 } },
  { name: "script setup", input: `<script setup>export default {};</script>`, expected: { code: "export default {};", language: "javascript", startLine: 1 } },
  { name: "lang double quoted ts", input: `<script lang="ts">const x: number = 1;</script>`, expected: { code: "const x: number = 1;", language: "typescript", startLine: 1 } },
  { name: "lang single quoted ts", input: `<script lang='ts'>const x: number = 1;</script>`, expected: { code: "const x: number = 1;", language: "typescript", startLine: 1 } },
  // 未加引号的 `lang=ts` 不认（判据是 `lang` 后跟引号包裹的 `ts`）⇒ 回落 javascript。
  { name: "lang unquoted ts", input: `<script lang=ts>const x: number = 1;</script>`, expected: { code: "const x: number = 1;", language: "javascript", startLine: 1 } },
  // 属性名与属性值都大小写敏感：`LANG` / `TS` / `Ts` 都不算 ts（判据是字面量 `lang` + `ts`）。
  { name: "lang upper case value", input: `<script LANG="TS">const x: number = 1;</script>`, expected: { code: "const x: number = 1;", language: "javascript", startLine: 1 } },
  { name: "lang attribute name upper case", input: `<script LANG="ts">const x: number = 1;</script>`, expected: { code: "const x: number = 1;", language: "javascript", startLine: 1 } },
  { name: "lang mixed case value", input: `<script lang="Ts">const x: number = 1;</script>`, expected: { code: "const x: number = 1;", language: "javascript", startLine: 1 } },
  { name: "lang js explicit", input: `<script lang="js">export default {};</script>`, expected: { code: "export default {};", language: "javascript", startLine: 1 } },
  // HTML 标签名大小写无关：开闭标签可以任意大小写混用。
  { name: "uppercase SCRIPT tags", input: `<SCRIPT>export default {};</SCRIPT>`, expected: { code: "export default {};", language: "javascript", startLine: 1 } },
  { name: "mixed case Script tags", input: `<Script>export default {};</sCrIpT>`, expected: { code: "export default {};", language: "javascript", startLine: 1 } },
  { name: "whitespace before >", input: `<script   >export default {};</script>`, expected: { code: "export default {};", language: "javascript", startLine: 1 } },
  { name: "attributes before >", input: `<script setup lang="ts"   >export default {};</script>`, expected: { code: "export default {};", language: "typescript", startLine: 1 } },
  // 自闭合的 `<script/>` 不是块起始，也不是块结束——后续标签被它当成 raw text 吞掉。
  { name: "self closing script", input: `<script/>`, expected: null },
  { name: "self closing script then real", input: `<script/>\n<script>export default {};</script>`, expected: { code: "<script>export default {};", language: "javascript", startLine: 1 } },
  // 未闭合的 `<script>` 不猜内容边界（旧实现同样如此）⇒ 找不到闭合标签即 null。
  { name: "unclosed script", input: `<script>export default {};`, expected: null },
  { name: "unclosed script then closed one", input: `<script>const a = 1;</script>`, expected: { code: "const a = 1;", language: "javascript", startLine: 1 } },
  // 三处跳过上下文之一：HTML 注释里的 `<script>` 不参与边界判定。
  { name: "script inside html comment", input: `<!-- <script>const hidden = 1;</script> -->\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  // 三处跳过上下文之二：插值里的字符串字面量（含模板字面量）里的 `<script>` 是表达式内容。
  { name: "script inside interpolation string", input: `<template>{{ "<script>const hidden = 1;</script>" }}</template>\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  { name: "script inside interpolation template literal", input: "<template>{{ `<script>const hidden = 1;</script>` }}</template>\n<script>export default {};</script>", expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  // 三处跳过上下文之三：标签内部的属性值可以含 `>` 与 `</script>`。
  { name: "closing tag inside attribute value", input: `<template><div data-x="</script> >"></div></template>\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  // raw text 元素 `<style>` 的 CSS 里的 `<script` / `</script` 都不是标签。
  { name: "style block containing script open", input: `<style>.a::before { content: "<script>"; }</style>\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  { name: "style block containing script close", input: `<style>.a::before { content: "</script>"; }</style>\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  // CRLF 不计入额外行：`\r\n` 只让 `split("\n")` 多算一行的起点，占位仍按 `\n` 计数。
  { name: "crlf input", input: `<template><div/></template>\r\n<script lang="ts">const x: number = 1;</script>\r\n`, expected: { code: "\nconst x: number = 1;", language: "typescript", startLine: 2 } },
  // 行号对齐：script 之前每多一行，占位就多一个 `\n`。
  { name: "leading blank lines before script", input: `\n\n\n<script>export default {};</script>`, expected: { code: "\n\n\nexport default {};", language: "javascript", startLine: 4 } },
  { name: "script not first line", input: `<template>\n<div/>\n</template>\n\n<script>export default {};</script>`, expected: { code: "\n\n\n\nexport default {};", language: "javascript", startLine: 5 } },
  // 多个块：第一个内联块胜出。
  { name: "first of two script blocks wins", input: `<script>const first = 1;</script>\n<script>const second = 2;</script>`, expected: { code: "const first = 1;", language: "javascript", startLine: 1 } },
  // 空块是合法块（不是"没有块"）：返回空字符串而不是 null。
  { name: "empty script block", input: `<script></script>`, expected: { code: "", language: "javascript", startLine: 1 } },
  { name: "empty script setup block", input: `<script setup></script>`, expected: { code: "", language: "javascript", startLine: 1 } },
  // 空块胜出后不再往后找（`</script>` 已把边界交给第一个块）。
  { name: "empty script then real script", input: `<script></script>\n<script>export default {};</script>`, expected: { code: "", language: "javascript", startLine: 1 } },
  // 未闭合的 `<!--` 吞掉文件剩余部分 ⇒ 没有可证明的块，返回 null（不猜）。
  { name: "unterminated html comment before script", input: `<!-- <script>const hidden = 1;\n<script>export default {};</script>`, expected: null },
  // 未闭合的 `{{` 同样吞掉剩余部分 ⇒ null。
  { name: "unterminated interpolation before script", input: `{{ "<script>const hidden = 1;\n<script>export default {};</script>`, expected: null },
  { name: "unterminated interpolation then real script", input: `{{ a }}\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  // 内容开头的空行被剥掉（否则行号对齐会多算），但占位前缀保留。
  { name: "script leading newlines stripped", input: `<script>\n\n\nexport default {};</script>`, expected: { code: "export default {};", language: "javascript", startLine: 1 } },
  { name: "src attribute on second script only", input: `<script src="a.js"></script>\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  { name: "src with spaces", input: `<script   src = "./x.js"  ></script>\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  // `src=` 出现在属性值内部也算外部脚本（判据是标签文本上的 `\bsrc\s*=`）⇒ null。
  { name: "src inside attribute value literal", input: `<script data-note="src=">export default {};</script>`, expected: null },
  // 以下 5 例来自重构时的**差分复核**（6225 例语料里唯一出现过的分歧输入）：外部脚本必须吃掉整段
  // raw text，否则其中的 `</script>` 与后续标签会被重新当成块起始；把它们钉进矩阵防止回归。
  { name: "external script then inner literal", input: `<script src="./x.js"><script setup>\t}}</script>`, expected: null },
  { name: "external script then self-closing literal", input: `<script src="./x.js"> export default {};<script/>\\/*<script/></script>`, expected: null },
  { name: "external script then empty inner pair", input: `<script src="./x.js"><script/></script>{{ >\\"`, expected: null },
  { name: "external script then less-than literal", input: `<script src="./x.js">/<script><src=<!--</script>`, expected: null },
  { name: "external script after text", input: `}}<script src="./x.js"><script setup>*/\t</script>`, expected: null },
  // 自闭合 `<script/>` 不是 HTML 的 raw text 元素：它按普通标签跳过，后续 `<script>` 被当成它的内容。
  { name: "self closing script then real script", input: `<script/><script>a</script>`, expected: { code: "<script>a", language: "javascript", startLine: 1 } },
  { name: "external script then plain script", input: `<script src="a.js"><script>b</script></script>`, expected: null },
  { name: "less than text", input: `<template><p>{{ a < b }}</p></template>\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  { name: "digit after less than", input: `<template><p>1 <2 items</p></template>\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  // raw text 闭合规则：`</script` 后接空白、`/`、`>` 或 EOF 都算结束。
  { name: "raw text boundary slash", input: `<script>const a = 1;</script/>`, expected: { code: "const a = 1;", language: "javascript", startLine: 1 } },
  { name: "raw text boundary eof", input: `<script>const a = 1;</script`, expected: { code: "const a = 1;", language: "javascript", startLine: 1 } },
  // `</scriptx>` 是名字前缀不匹配 ⇒ 不算闭合；`</script x>` 接空白 ⇒ 算闭合。
  { name: "script name prefix not a match", input: `<script>const a = 1;</scriptx>`, expected: null },
  { name: "script name prefix with space", input: `<script>const a = 1;</script x>`, expected: { code: "const a = 1;", language: "javascript", startLine: 1 } },
  // 插值里的块注释/行注释按 JS 词法跳过，注释中的 `}}` 不提前收尾。
  { name: "comment inside interpolation", input: `<template>{{ a /* }} */ }}</template>\n<script>export default {};</script>`, expected: { code: "\nexport default {};", language: "javascript", startLine: 2 } },
  { name: "line comment inside interpolation", input: `<template>{{ a // }}\n}}</template>\n<script>export default {};</script>`, expected: { code: "\n\nexport default {};", language: "javascript", startLine: 3 } },
  // 已声明边界：自定义块（`<i18n>`）不按 raw text 跳过，其中的 `<script` 字面量会被当作块边界。
  // 这不是本次修复引入的退化（旧正则实现同样如此），矩阵把现状钉住以免"顺手修正"改变判定语义。
  { name: "custom block with script literal", input: `<i18n>{ "a": "<script>" }</i18n>\n<script>export default {};</script>`, expected: { code: `" }</i18n>\n<script>export default {};`, language: "javascript", startLine: 1 } },
  { name: "fixture vue-basic-script", input: fixture("vue-basic-script.vue"), expected: { code: `\n\n\n\nimport { createCounter } from "./create-counter";\n\nexport default {\n  name: "BasicCounter",\n  data() {\n    return { count: 0 };\n  },\n  methods: {\n    increment() {\n      if (this.count >= 10) {\n        this.count = 0;\n      } else {\n        this.count += 1;\n      }\n    },\n  },\n};\n`, language: "javascript", startLine: 5 } },
  { name: "fixture vue-script-setup-ts", input: fixture("vue-script-setup-ts.vue"), expected: { code: `\n\n\n\nimport { ref } from "vue";\n\nconst total = ref<number>(0);\n\nfunction increment(): void {\n  total.value += 1;\n}\n`, language: "typescript", startLine: 5 } },
  { name: "fixture vue-mustache-script-literal", input: fixture("vue-mustache-script-literal.vue"), expected: { code: `\n\n\n\nimport { audit } from "./audit";\n\nexport default {\n  name: "AuditPanel",\n  methods: {\n    run(threshold) {\n      if (threshold > 0) {\n        return audit(this.name, threshold);\n      }\n      return audit(this.name);\n    },\n  },\n};\n`, language: "javascript", startLine: 5 } },
  { name: "fixture vue-comment-script-literal", input: fixture("vue-comment-script-literal.vue"), expected: { code: `\n\n\n\nimport { audit } from "./audit";\n\nexport default {\n  name: "AuditPanel",\n  methods: {\n    run(threshold) {\n      if (threshold > 0) {\n        return audit(this.name, threshold);\n      }\n      return audit(this.name);\n    },\n  },\n};\n`, language: "javascript", startLine: 5 } },
  { name: "fixture vue-attribute-script-literal", input: fixture("vue-attribute-script-literal.vue"), expected: { code: `\n\n\n\nimport { audit } from "./audit";\n\nexport default {\n  name: "AuditPanel",\n  methods: {\n    run(threshold) {\n      if (threshold > 0) {\n        return audit(this.name, threshold);\n      }\n      return audit(this.name);\n    },\n  },\n};\n`, language: "javascript", startLine: 5 } },
  { name: "fixture vue-hostile-control", input: fixture("vue-hostile-control.vue"), expected: { code: `\n\n\n\nimport { audit } from "./audit";\n\nexport default {\n  name: "AuditPanel",\n  methods: {\n    run(threshold) {\n      if (threshold > 0) {\n        return audit(this.name, threshold);\n      }\n      return audit(this.name);\n    },\n  },\n};\n`, language: "javascript", startLine: 5 } },
];

describe("extractVueScriptBlock（.vue script 块提取，行为特征矩阵）", () => {
  it("pins the whole crafted corpus at once", () => {
    const actual = CASES.map((testCase) => ({ name: testCase.name, output: probe(testCase.input) }));
    expect(actual).toEqual(CASES.map((testCase) => ({ name: testCase.name, output: testCase.expected })));
  });

  it("keeps the matrix size visible so the table cannot silently shrink", () => {
    expect(CASES.length).toBe(61);
  });

  // loc 对齐契约（与 TsStrategy.parseVue 的约定）：`code` 的首行必须落在原文件的 `startLine` 上。
  it.each([
    { name: "plain script on line 1", input: `<script>const a = 1;</script>`, startLine: 1, content: "const a = 1;" },
    { name: "script after four lines", input: `<template>\n<div/>\n</template>\n\n<script>const a = 1;</script>`, startLine: 5, content: "const a = 1;" },
    { name: "script after three blank lines", input: `\n\n\n<script>const a = 1;</script>`, startLine: 4, content: "const a = 1;" },
    { name: "crlf host document", input: `<template><div/></template>\r\n<script>const a = 1;</script>`, startLine: 2, content: "const a = 1;" },
  ])("aligns $name to line $startLine with blank-line padding", ({ input, startLine, content }) => {
    const result = extractVueScriptBlock(input);

    expect(result).not.toBeNull();
    expect(result!.startLine).toBe(startLine);
    // 断言的是逐行事实，不只整体相等：前 startLine-1 行必须全是空行占位。
    const lines = result!.code.split("\n");
    expect(lines.length).toBe(startLine);
    expect(lines.slice(0, startLine - 1).every((line) => line === "")).toBe(true);
    expect(lines[startLine - 1]).toBe(content);
  });

  it("keeps the null returns distinguishable from an empty block", () => {
    // 契约边界：`null` = 没有可证明的内联 script 块；`""` = 有空块。
    expect(extractVueScriptBlock(`<script src="./x.js"></script>`)).toBeNull();
    expect(extractVueScriptBlock(`<script>`)).toBeNull();
    expect(extractVueScriptBlock(`<template><div/></template>`)).toBeNull();
    expect(extractVueScriptBlock(`<script></script>`)?.code).toBe("");
  });
});
