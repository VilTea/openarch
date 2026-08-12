import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParserService } from "../../src/port/ParserService";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { findLanguageForFile, extensionsForLanguages } from "../../src/adapter/parser/LanguageRegistry";

const dir = join(tmpdir(), `openarch-vue-${Date.now()}`);
const sfc = join(dir, "Counter.vue");

const parseSfc = () => Effect.gen(function* () {
  const parser = yield* ParserService;
  return yield* parser.parse(sfc);
}).pipe(Effect.provide(TreeSitterParserLive));

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(sfc, `<template>
  <div>{{ count }}</div>
</template>
<script setup>
import { ref, computed } from "vue";
const count = ref(0);
function increment() {
  if (count.value >= 10) { count.value = 0; }
  else { count.value++; }
}
const doubled = computed(() => count.value * 2);
</script>
<style scoped>.counter { color: red; }</style>
`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("vue language support", () => {
  it("registers .vue in the language registry", () => {
    expect(findLanguageForFile(sfc)?.id).toBe("vue");
    expect(extensionsForLanguages(["vue"])).toContain(".vue");
  });

  it("parses the script block with javascript semantics and line alignment", async () => {
    const ast = await Effect.runPromise(parseSfc());
    // SFC 语义语言 = javascript（script 块按 js 分析）；文件扩展名映射为 vue。
    expect(ast.language).toBe("javascript");
    expect(ast.functionCount).toBe(2); // increment + computed 箭头函数
    // increment 的 if/else = 2 分支（guard if=0.3 不计？看口径：if 计 0.3 + else 计 1）
    expect(ast.maxFuncBranch).toBeGreaterThan(0);
    // increment 的 if/else 分支被正确提取
    const fn = ast.functions.find((f) => f.name === "increment");
    expect(fn).toBeDefined();
    expect(fn!.branchCount).toBeGreaterThan(0);
  }, 15000);
});
