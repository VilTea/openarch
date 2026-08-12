import { describe, expect, it } from "vitest";
import { extractVueScriptBlock } from "../../src/adapter/parser/VueScriptExtractor";

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
});
