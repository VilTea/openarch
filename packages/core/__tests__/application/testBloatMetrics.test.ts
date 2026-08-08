import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { codeSimilarityRatio, testGrowthRatio, testBloatMetrics, listTestFiles } from "../../src/application/testBloatMetrics";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { ParserService } from "../../src/port/ParserService";

const parser = Effect.runSync(
  Effect.gen(function* () {
    return yield* ParserService;
  }).pipe(Effect.provide(TreeSitterParserLive)),
);

const SAMPLE = (): string => `
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("sample", () => {
  it("creates a temp fixture", () => {
    const cwd = join(process.cwd(), \`.tmp-fixture-\${Date.now()}\`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;");
    writeFileSync(join(cwd, "b.ts"), "export const b = 2;");
    expect(1).toBe(1);
    rmSync(cwd, { recursive: true, force: true });
  });
});
`;

describe("testBloatMetrics", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = join(process.cwd(), `.tmp-bloat-test-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("detects duplicated fixture boilerplate via block-level minhash similarity", async () => {
    // 两个测试文件共享完全相同的 8 行 fixture 样板块
    writeFileSync(join(cwd, "a.test.ts"), SAMPLE());
    writeFileSync(join(cwd, "b.test.ts"), SAMPLE().replace(/Date\.now\(\)/g, "Date.now() + 1"));
    const files = [join(cwd, "a.test.ts"), join(cwd, "b.test.ts")];
    const ratio = codeSimilarityRatio(files);
    expect(ratio).toBeGreaterThan(0);
    // 重复样板块应显著（两文件几乎相同 → 相似块比例高）
    const metrics = await testBloatMetrics(cwd, files, parser);
    expect(metrics.fixtureBoilerplateRatio).toBeGreaterThan(0.05);
    expect(metrics.codeSimilarityRatio).toBeGreaterThan(0);
  });

  it("reports low similarity for distinct test files", async () => {
    writeFileSync(join(cwd, "a.test.ts"), SAMPLE());
    writeFileSync(join(cwd, "b.test.ts"), [
      'import { describe, expect, it } from "vitest";',
      'import { add } from "../src/add";',
      'describe("add", () => {',
      '  it("sums", () => {',
      "    expect(add(1, 2)).toBe(3);",
      "  });",
      "});",
    ].join("\n"));
    const ratio = codeSimilarityRatio([join(cwd, "a.test.ts"), join(cwd, "b.test.ts")]);
    expect(ratio).toBeLessThan(0.1);
  });

  it("lists only test files", () => {
    writeFileSync(join(cwd, "a.test.ts"), SAMPLE());
    writeFileSync(join(cwd, "src.ts"), "export const x = 1;");
    const files = listTestFiles(cwd);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("a.test.ts");
  });

  it("keeps the mathematical closure: score equals the sum of contributions", async () => {
    writeFileSync(join(cwd, "a.test.ts"), SAMPLE());
    writeFileSync(join(cwd, "b.test.ts"), SAMPLE());
    const files = [join(cwd, "a.test.ts"), join(cwd, "b.test.ts")];
    const metrics = await testBloatMetrics(cwd, files, parser);
    const sum = metrics.parts.reduce((acc, part) => acc + part.contribution, 0);
    expect(sum).toBeCloseTo(metrics.score, 6);
    // 每个分量贡献 = wᵢ·min(1, vᵢ/Tᵢ)
    for (const part of metrics.parts) {
      expect(part.contribution).toBeCloseTo(part.weight * Math.min(1, part.value / part.threshold), 6);
    }
  });

  it("returns 0 growth ratio outside a git repo", () => {
    const nonGit = join(require("node:os").tmpdir(), `.tmp-non-git-${Date.now()}`);
    mkdirSync(nonGit, { recursive: true });
    try {
      expect(testGrowthRatio(nonGit, 5)).toBe(0);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("tolerates complete coverage suites: sizeDispersion measures P95 tail departure, not max/median", async () => {
    // 完整覆盖矩阵：1 个大文件（同主题 30 用例）+ 多个小文件——max 是 P95 的 1.6 倍，不触发
    writeFileSync(join(cwd, "big.test.ts"), [0, 0, 0, 0, 0].map((_, i) => `describe("suite ${i}", () => { it("case", () => expect(${i}).toBe(${i})); });`).join("\n") + "\n".repeat(300));
    for (let i = 0; i < 10; i += 1) writeFileSync(join(cwd, `small-${i}.test.ts`), `it("x${i}", () => expect(${i}).toBe(${i}));\n`);
    const files = [join(cwd, "big.test.ts"), ...[0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map((_, i) => join(cwd, `small-${i}.test.ts`))];
    const metrics = await testBloatMetrics(cwd, files, parser);
    // 大文件是 P95 的自然延伸（完整套件合法），脱离度 < 2 不触发
    expect(metrics.sizeDispersion).toBeLessThan(2);
    expect(metrics.parts.find((part) => part.name === "sizeDispersion")?.threshold).toBe(2);
    // 未触发因子的证据不出现
    expect(metrics.evidence.some((entry) => entry.factor === "sizeDispersion")).toBe(false);
  });

  it("emits file-level evidence for triggered factors (agent can locate the bloat source)", async () => {
    // fixture 样板触发：两文件都含 mkdirSync/writeFileSync/rmSync 样板
    writeFileSync(join(cwd, "a.test.ts"), SAMPLE());
    writeFileSync(join(cwd, "b.test.ts"), SAMPLE().replace(/Date\.now\(\)/g, "Date.now() + 1"));
    const files = [join(cwd, "a.test.ts"), join(cwd, "b.test.ts")];
    const metrics = await testBloatMetrics(cwd, files, parser);

    expect(metrics.fixtureBoilerplateRatio).toBeGreaterThan(0.08);
    const fixtureEvidence = metrics.evidence.filter((entry) => entry.factor === "fixtureBoilerplateRatio");
    expect(fixtureEvidence.length).toBeGreaterThan(0);
    for (const entry of fixtureEvidence) {
      expect(entry.file.endsWith("a.test.ts") || entry.file.endsWith("b.test.ts")).toBe(true); // 仓库相对路径
      expect(entry.file.startsWith(join(cwd, ""))).toBe(false); // 不含 cwd 前缀
      expect(entry.detail).toContain("fixture 调用");
      expect(entry.value).toBeGreaterThan(0);
    }
  });

  it("excludes semantic-subject fixture calls from boilerplate (distinct structures are not boilerplate)", async () => {
    // 一个写源码文件（writeFileSync），另一个建目录（mkdirSync）——函数与结构都不同 → 非重复样板
    writeFileSync(join(cwd, "a.test.ts"), [
      'import { describe, it, expect } from "vitest";',
      'import { writeFileSync } from "node:fs";',
      'const apiSource = "export const one = 1;";',
      'describe("api contract", () => {',
      '  it("roundtrips a decimal", () => {',
      '    writeFileSync("/tmp/api/a.ts", apiSource);',
      "    expect(1).toBe(1);",
      "  });",
      "});",
    ].join("\n"));
    writeFileSync(join(cwd, "b.test.ts"), [
      'import { describe, it, expect } from "vitest";',
      'import { mkdirSync } from "node:fs";',
      'describe("render pipeline", () => {',
      '  it("hydrates a template", () => {',
      '    mkdirSync("/tmp/render/out");',
      "    expect(2).toBe(2);",
      "  });",
      "});",
    ].join("\n"));
    const files = [join(cwd, "a.test.ts"), join(cwd, "b.test.ts")];
    const metrics = await testBloatMetrics(cwd, files, parser);

    // writeFileSync 与 mkdirSync 结构不同 → 非重复样板（低于阈值）
    expect(metrics.fixtureBoilerplateRatio).toBeLessThan(0.08);
  });
});
