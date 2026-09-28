import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractVueScriptBlock } from "../../src/adapter/parser/VueScriptExtractor";
import { parseVue } from "../../src/adapter/parser/TsStrategy";

/** 夹具路径：SFC 提取是解析前置步骤，先证明提取边界，再证明解析事实不被模板污染。 */
const fixturePath = (name: string): string => resolve(__dirname, "..", "..", "fixtures", name);
const fixtureText = (name: string): string => readFileSync(fixturePath(name), "utf8");

const parseFixture = (name: string) => Effect.runPromise(parseVue(fixturePath(name)));

// 三个"敌意模板"夹具的 script 块与 vue-hostile-control.vue 逐字节相同，
// 唯一差别是模板里出现 `<script>` / `</script>` 字面量：解析事实必须与对照夹具完全一致。
const HOSTILE_FIXTURES = [
  "vue-mustache-script-literal.vue",
  "vue-comment-script-literal.vue",
  "vue-attribute-script-literal.vue",
] as const;

describe("extractVueScriptBlock", () => {
  const sfc = `<template><div>hi</div></template>
<script setup>
import { ref } from "vue";
const count = ref(0);
function inc() { if (count.value > 0) { count.value++; } }
</script>
<style>.a{}</style>`;

  it("extracts setup script block with line-number alignment", () => {
    const result = extractVueScriptBlock(sfc);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("javascript");
    expect(result!.startLine).toBe(2);
    // 行号对齐：提取文本第 1 行是原文件第 1 行（空行占位），内容从原第 2 行开始。
    const lines = result!.code.split("\n");
    expect(lines[0]).toBe("");
    expect(lines[1]).toContain('import { ref } from "vue"');
    expect(lines[3]).toContain("function inc()");
  });

  it("returns null when no script block exists", () => {
    expect(extractVueScriptBlock(`<template><div/></template>`)).toBeNull();
  });

  it("skips external <script src> blocks", () => {
    expect(extractVueScriptBlock(`<script src="./x.js"></script>`)).toBeNull();
  });

  it("detects lang=ts as typescript semantics", () => {
    expect(extractVueScriptBlock(`<script lang="ts">const x: number = 1;</script>`)?.language).toBe("typescript");
  });

  it("extracts a plain <script> block from the SFC fixture", () => {
    const source = fixtureText("vue-basic-script.vue");
    const result = extractVueScriptBlock(source);

    expect(result).not.toBeNull();
    expect(result!.startLine).toBe(5);
    expect(result!.language).toBe("javascript");
    expect(result!.code).toContain('import { createCounter } from "./create-counter";');
    expect(result!.code).toContain('name: "BasicCounter"');
    // 行号对齐：原文件第 5 行是 script 起始行，提取文本前 4 行用空行占位。
    const lines = result!.code.split("\n");
    expect(lines.slice(0, 4).every((line) => line === "")).toBe(true);
    expect(lines[4]).toContain('import { createCounter } from "./create-counter";');
    expect(result!.code).not.toContain("<template>");
  });

  it("skips the raw text of a <style> block that contains a <script> literal", () => {
    const source = `<template><div/></template>
<style>
.a::before { content: "<script>"; }
</style>
<script>export default {};</script>`;
    const result = extractVueScriptBlock(source);

    expect(result).not.toBeNull();
    expect(result!.startLine).toBe(5);
    expect(result!.code).toContain("export default {}");
  });

  it("picks the inline script that follows a <script src> block", () => {
    const source = `<script src="./external.js"></script>
<script>export default { inline: true };</script>`;
    const result = extractVueScriptBlock(source);

    expect(result).not.toBeNull();
    expect(result!.startLine).toBe(2);
    expect(result!.code).toContain("inline: true");
  });

  it("treats `a < b` template text as text, not as a tag", () => {
    const source = `<template><p>{{ a < b }}</p><div>x</div></template>
<script>export default {};</script>`;
    expect(extractVueScriptBlock(source)?.code).toContain("export default {}");
  });

  it("does not treat `<2` in template text as a tag open", () => {
    const source = `<template><p>1 <2 items</p><script>export default {};</script></template>`;
    expect(extractVueScriptBlock(source)?.code).toContain("export default {}");
  });

  it("does not end an interpolation at a `}}` inside a string literal", () => {
    const source = `<template><p>{{ "</script> }} <script>" }}</p></template>
<script>export default {};</script>`;
    const result = extractVueScriptBlock(source);

    expect(result).not.toBeNull();
    expect(result!.startLine).toBe(2);
    expect(result!.code).toContain("export default {}");
    expect(result!.code).not.toContain("</script> }}");
  });

  it("keeps <script setup lang=\"ts\"> aligned and typed", () => {
    const result = extractVueScriptBlock(fixtureText("vue-script-setup-ts.vue"));

    expect(result).not.toBeNull();
    expect(result!.startLine).toBe(5);
    expect(result!.language).toBe("typescript");
    expect(result!.code).toContain("function increment(): void {");
  });

  it.each(HOSTILE_FIXTURES)("extracts only the real script block from %s", (name) => {
    const result = extractVueScriptBlock(fixtureText(name));

    expect(result).not.toBeNull();
    expect(result!.startLine).toBe(5);
    expect(result!.code).toContain('import { audit } from "./audit";');
    // 模板 HTML 绝不进入 JS 解析：没有模板标签、没有被截断的插值或属性残片。
    expect(result!.code).not.toContain("<template>");
    expect(result!.code).not.toContain("</template>");
    expect(result!.code).not.toContain("{{");
    expect(result!.code).not.toContain("<!--");
  });

  it("produces identical parse facts for hostile templates and the clean control", async () => {
    const control = await parseFixture("vue-hostile-control.vue");
    const comparable = (ast: typeof control) => ({ ...ast, path: "<fixture>" });

    for (const name of HOSTILE_FIXTURES) {
      const hostile = await parseFixture(name);
      // 模板里的 `<script>` / `</script>` 字面量只影响模板，不得改变 loc / 分支 / 导入图等任何事实。
      expect(comparable(hostile)).toEqual(comparable(control));
    }
    // 对照夹具本身必须真的解析出了 script 块的事实（否则上面的相等断言无意义）。
    expect(control.imports.map((entry) => entry.source)).toEqual(["./audit"]);
    expect(control.functionCount).toBeGreaterThan(0);
  }, 30000);
});
