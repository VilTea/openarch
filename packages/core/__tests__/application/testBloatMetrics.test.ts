import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { codeSimilarityRatio, testBloatMetrics } from "../../src/application/testBloatMetrics";
import { TreeSitterParserLive } from "../../src/adapter/parser/ParserFactory";
import { ParserService } from "../../src/port/ParserService";
import { initGit, withTemporaryDirectory } from "../support/temporaryDirectory";

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

  /**
   * 便捷导出 `testGrowthRatio` 已删除（它把 availability 压成 number，非 git 时返回 0 —
   * 正是"把不可测序列化成 0"的旧反模式）。改为直接断言**事实边界**：既不能算增长，
   * 也不能声称 0。
   */
  it("never claims a growth ratio outside a git repo (unavailable, not 0)", async () => {
    const nonGit = join(require("node:os").tmpdir(), `.tmp-non-git-${Date.now()}`);
    mkdirSync(nonGit, { recursive: true });
    try {
      const file = join(nonGit, "a.test.ts");
      writeFileSync(file, SAMPLE());
      const metrics = await testBloatMetrics(nonGit, [file], parser);
      const growth = partOf(metrics, "growthRatio");
      expect(growth.value).toBeUndefined();
      expect(growth.availability).toBe("UNAVAILABLE");
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

/** 自包含 git 仓库夹具（tmpdir，不在 openarch 仓库内）：numstat 只反映夹具自身，
 *  因此 growthRatio/分数可钉死为确定值（不受 openarch 自身历史影响）。
 *  Java 夹具是真实 JUnit5 形状：两个测试类共享同一 @BeforeEach + H2 seed 块。 */
const seedGitRepository = (directory: string, files: Record<string, string>): void => {
  initGit(directory);
  for (const [name, content] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "seed"], { cwd: directory });
};

const JAVA_TEST_CLASS = (name: string): string => `package com.example.orders;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest
@TestPropertySource(properties = {"spring.datasource.url=jdbc:h2:mem:orders"})
class ${name} {

    @Autowired
    private OrderRepository repository;

    @Autowired
    private OrderService service;

    private Order seed;

    @BeforeEach
    void setUp() {
        repository.deleteAll();
        seed = new Order();
        seed.setId(42L);
        seed.setStatus("NEW");
        seed.setAmount(new BigDecimal("19.99"));
        repository.save(seed);
    }

    @Test
    void loadsSeededOrder() {
        Order found = service.findById(42L);
        assertNotNull(found);
        assertEquals("NEW", found.getStatus());
        assertTrue(found.getAmount().compareTo(new BigDecimal("19.99")) == 0);
    }
}
`;

const TS_GIT_SAMPLE = (): string => `
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

/**
 * 语言形状契约（2026-09-27 §6/Q1 覆盖）对**弱断言判据**的接线证据。
 *
 * 特征化基线（改动前实测，见交接记录）：同一份 TS 夹具
 * （`toBeTruthy` / `toBeFalsy` / `toBeDefined` + 一处 `toBe(3)`）
 * ⇒ `weakAssertionRatio = 0.6`（内置名单 `toBeTruthy|toBeFalsy` 命中 3/5：
 * `toBeDefined` **不计**，`toBe(3)` 不计分子但计分母 ⇒ 3/5）。
 * Java 夹具 ⇒ `2/3`（`assertNotNull` + `assertTrue` / 3 个断言）。
 *
 * 本组用例锁住：
 * - 不传 shapes ⇒ 与内置逐位一致 + 披露 `builtin`；
 * - 声明后**覆盖**（不是追加）：内置名字不再命中，项目名字开始命中；
 * - 声明是按语言的：只声明 TS 不影响 Java 的内置名单；
 * - 多语言下披露是投影（任一语言用项目名单 ⇒ `project`）。
 */
const TS_WEAK_SAMPLE = (): string => `
import { describe, expect, it } from "vitest";

describe("weak", () => {
  it("truthiness only", () => {
    expect(flag()).toBeTruthy();
  });
  it("falsy only", () => {
    expect(flag()).toBeFalsy();
  });
  it("defined only", () => {
    expect(value()).toBeDefined();
  });
  it("mixed", () => {
    expect(flag()).toBeTruthy();
    expect(value()).toBe(3);
  });
});
`;

describe("testBloatMetrics × 声明式语言形状（§6/Q1 覆盖语义）", () => {
  it("keeps the built-in judgement when nothing is declared, and discloses source=builtin", async () => {
    await withTemporaryDirectory("shapes-builtin", async (directory) => {
      const file = join(directory, "src/a.test.ts");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, TS_WEAK_SAMPLE());
      const metrics = await testBloatMetrics(directory, [file], parser);

      // 内置名单（assertionRecognition 的 WEAK_TS_ASSERTION_METHODS）逐位不变：
      // toBeTruthy ×2 + toBeFalsy ×1 = 3 弱 / 5 个 expect（toBeDefined、toBe(3) 不计入分子）。
      expect(metrics.weakAssertionRatio).toBe(0.6);
      expect(partOf(metrics, "weakAssertionRatio").threshold).toBe(0.03);
      expect(metrics.weakAssertionShapesSource).toBe("builtin");
      // F-D（2026-09-27 独立复验修正）：证据里的**绝对个数**必须等于真实调用点。此前
      // `patternProbe` 累加**每个 capture** 的行数，而每个模式有 2 个 capture（`@fn`+`@call`）
      // ⇒ 打印 `弱断言 6/10 处`，是事实（3/5）的两倍。比率不受影响，故分数一直是对的，
      // 但"报告里的一句数字"与事实不符（本批整改的同一缺陷类别）。
      expect(metrics.evidence?.map((entry) => entry.detail)).toContain("弱断言 3/5 处");
    });
  });

  it("replaces the built-in list with the declared one (override, not append) and discloses source=project", async () => {
    await withTemporaryDirectory("shapes-declared", async (directory) => {
      const file = join(directory, "src/a.test.ts");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, TS_WEAK_SAMPLE());

      // 项目声明一个**内置名单里没有**的名字：若语义是"追加"，内置的 toBeTruthy/toBeFalsy
      // 仍会命中（3/5）；只有"覆盖"才会得到 0/5 —— 这条就是覆盖语义的判别证据。
      const declared = await testBloatMetrics(directory, [file], parser, undefined, {
        typescript: { weakAssertionMethods: ["toBeDefined"] },
      });
      expect(declared.weakAssertionRatio).toBe(0.2); // 只剩 toBeDefined 1/5（项目声明生效）
      expect(declared.weakAssertionShapesSource).toBe("project");

      // 反向对照：声明内置名单里的另一个名字 ⇒ 分子随之改变，证明用的是声明而不是内置。
      const declaredFalsy = await testBloatMetrics(directory, [file], parser, undefined, {
        typescript: { weakAssertionMethods: ["toBeFalsy"] },
      });
      expect(declaredFalsy.weakAssertionRatio).toBe(0.2); // 1/5
      expect(declaredFalsy.weakAssertionShapesSource).toBe("project");
    });
  });

  it("applies a declaration per language: declaring TS leaves Java on the built-in list", async () => {
    await withTemporaryDirectory("shapes-per-language", async (directory) => {
      const directoryPath = join(directory, "src");
      mkdirSync(directoryPath, { recursive: true });
      const javaFile = join(directoryPath, "OrderServiceTest.java");
      writeFileSync(javaFile, JAVA_TEST_CLASS("OrderServiceTest"));
      const tsFile = join(directoryPath, "a.test.ts");
      writeFileSync(tsFile, TS_WEAK_SAMPLE());

      const metrics = await testBloatMetrics(directory, [javaFile, tsFile], parser, undefined, {
        typescript: { weakAssertionMethods: ["toBeDefined"] },
      });
      // Java 仍是内置：assertNotNull + assertTrue = 2；TS 声明只命中 toBeDefined = 1。
      expect(metrics.weakAssertionShapesSource).toBe("project");
      expect(partOf(metrics, "weakAssertionRatio").availability).toBe("AVAILABLE");
      // 判据的分母/分子是跨文件合计（本因子的口径），因此只断言"声明确实改变了结果"：
      // 合计 expect = Java 3 + TS 5 = 8，弱 = Java 2 + TS 1 = 3 ⇒ 3/8。
      expect(metrics.weakAssertionRatio).toBeCloseTo(3 / 8, 12);

      // 对照：Java 单独跑（未声明 Java、TS 也不在该批次里）仍走内置 —— 覆盖只作用于被声明的语言。
      const javaOnly = await testBloatMetrics(directory, [javaFile], parser, undefined, {
        typescript: { weakAssertionMethods: ["toBeDefined"] },
      });
      expect(javaOnly.weakAssertionRatio).toBeCloseTo(2 / 3, 12);
      expect(javaOnly.weakAssertionShapesSource).toBe("builtin");
    });
  });
});

const partOf = (metrics: Awaited<ReturnType<typeof testBloatMetrics>>, name: string) =>
  metrics.parts.find((part) => part.name === name)!;

describe("testBloatMetrics factor availability（缺陷修复：不可测 ≠ 0，且可重归一化）", () => {
  it("reports per-factor availability for a Java-only suite: JUnit weak assertions measurable, fixture/growth not", async () => {
    await withTemporaryDirectory("bloat-java", async (directory) => {
      seedGitRepository(directory, {
        "src/main/java/com/example/orders/OrderService.java": "package com.example.orders;\npublic class OrderService {}\n",
        "src/main/java/com/example/orders/OrderRepository.java": "package com.example.orders;\npublic class OrderRepository {}\n",
        "src/test/java/com/example/orders/OrderServiceTest.java": JAVA_TEST_CLASS("OrderServiceTest"),
        "src/test/java/com/example/orders/OrderRepositoryTest.java": JAVA_TEST_CLASS("OrderRepositoryTest"),
      });
      const files = [
        join(directory, "src/test/java/com/example/orders/OrderServiceTest.java"),
        join(directory, "src/test/java/com/example/orders/OrderRepositoryTest.java"),
      ];
      const metrics = await testBloatMetrics(directory, files, parser);

      // 1. 语言绑定因子按**实际可测性**各自判定（D-G2 后 Java 只有两个不可测）：
      //    fixture 形状仍未实现（记录边界），weak 断言已由 JUnit 形状支持，growth 无 Java 历史。
      expect(partOf(metrics, "fixtureBoilerplateRatio")).toMatchObject({ availability: "UNAVAILABLE", reason: "language_not_supported_by_pattern" });
      expect(partOf(metrics, "growthRatio")).toMatchObject({ availability: "UNAVAILABLE", reason: "no_language_matched_history" });
      for (const name of ["fixtureBoilerplateRatio", "growthRatio"]) {
        expect(partOf(metrics, name).value).toBeUndefined();
      }
      // D-G2：weakAssertionRatio 对 Java 可测。夹具每个用例是
      // `assertNotNull + assertEquals + assertTrue` ⇒ 弱断言 2/3。
      expect(partOf(metrics, "weakAssertionRatio")).toMatchObject({ availability: "AVAILABLE" });
      expect(partOf(metrics, "weakAssertionRatio").value).toBeCloseTo(2 / 3, 6);
      // 校准出处（有意记录的比较边界）：阈值 0.03 是 **TS/JS 总体**校准出来的常量，
      // 这里被用于 Java 值。改语言阈值属"新增 P95/阈值维度"红线，需项目所有者另行决策。
      expect(partOf(metrics, "weakAssertionRatio").threshold).toBe(0.03);
      // 语言中立因子保持 AVAILABLE（Java 文件的块相似度与尺寸可测）
      expect(partOf(metrics, "codeSimilarityRatio").availability).toBe("AVAILABLE");
      expect(partOf(metrics, "sizeDispersion").availability).toBe("AVAILABLE");

      // 2. 不可测因子不出现在顶层字段里（宪法 §3：不可测不得序列化成 0）
      expect(metrics.fixtureBoilerplateRatio).toBeUndefined();
      expect(metrics.weakAssertionRatio).toBeCloseTo(2 / 3, 6);
      expect(metrics.growthRatio).toBeUndefined();
      const serialized = JSON.stringify(metrics);
      for (const key of ["fixtureBoilerplateRatio", "growthRatio"]) {
        expect(serialized).not.toContain(`"${key}":`);
      }

      // 3. 归一化分母只含可用因子：0.30(similarity) + 0.20(size) + 0.10(weak) = 0.60。
      //    贡献：similarity 触顶 0.30；size 值=1/阈值 2 ⇒ 0.20×0.5=0.10；
      //    weak 值=2/3 > 阈值 0.03 ⇒ 触顶 0.10。合计 0.50 ⇒ score = 0.50/0.60 ≈ 0.833。
      //    对照旧式子（不归一化）：Java 上限曾是 0.30+0.20 = 0.50，仅当严格 > 0.5 才触发，
      //    数学上永不可达；归一化让"可用因子里确实偏高"如实触发。
      const contributionSum = metrics.parts.reduce((sum, part) => sum + part.contribution, 0);
      expect(metrics.availableWeight).toBeCloseTo(0.6, 12);
      expect(contributionSum).toBeCloseTo(0.5, 12);
      expect(metrics.score).toBeCloseTo(contributionSum / metrics.availableWeight, 12);
      expect(metrics.score).toBeCloseTo(0.8333333333333334, 9);
      expect(metrics.triggered).toBe(true);
    });
  });

  it("keeps every TypeScript factor AVAILABLE, and excludes assertion blocks from the charge", async () => {
    await withTemporaryDirectory("bloat-ts", async (directory) => {
      seedGitRepository(directory, {
        "src/add.ts": `${Array.from({ length: 20 }, (_, index) => `export const value${index} = ${index};`).join("\n")}\n`,
        "src/a.test.ts": TS_GIT_SAMPLE(),
        "src/b.test.ts": TS_GIT_SAMPLE().replace(/Date\.now\(\)/g, "Date.now() + 1"),
      });
      const files = [join(directory, "src/a.test.ts"), join(directory, "src/b.test.ts")];
      const metrics = await testBloatMetrics(directory, files, parser);

      for (const part of metrics.parts) expect(part.availability).toBe("AVAILABLE");
      expect(metrics.availableWeight).toBe(1); // 全部可用 ⇒ Σw = 1.0 ⇒ 分母为 1（重归一化的回归保证）
      // 校准 2026-09-25（DRY/DAMP 平衡）：该样例的重复块含断言/验证调用，
      // 因此它们**不再计入** codeSimilarityRatio（旧口径是 1.25），而是单列在 assertionRatio。
      // 这是本次有意改变的行为，不是漂移。
      expect(metrics.codeSimilarityRatio).toBe(0.375);
      expect(metrics.similarityBuckets.assertionRatio).toBeGreaterThan(0);
      expect(metrics.codeSimilarityRatio).toBeLessThan(1.25);
      // 其余分量不受块语义影响，保持逐位锚点
      expect(metrics.fixtureBoilerplateRatio).toBe(0.28125);
      expect(metrics.sizeDispersion).toBe(1);
      expect(metrics.growthRatio).toBe(1.5);
      expect(metrics.weakAssertionRatio).toBe(0);
      const contributionSum = metrics.parts.reduce((sum, part) => sum + part.contribution, 0);
      expect(metrics.score).toBe(contributionSum); // 无重归一化：Σ contribution 原样
    });
  });

  it("carries block line ranges and sample text in the evidence (agent can locate the block)", async () => {
    await withTemporaryDirectory("bloat-evidence", async (directory) => {
      seedGitRepository(directory, {
        "src/main/java/com/example/orders/OrderService.java": "package com.example.orders;\npublic class OrderService {}\n",
        "src/test/java/com/example/orders/OrderServiceTest.java": JAVA_TEST_CLASS("OrderServiceTest"),
        "src/test/java/com/example/orders/OrderRepositoryTest.java": JAVA_TEST_CLASS("OrderRepositoryTest"),
      });
      const files = [
        join(directory, "src/test/java/com/example/orders/OrderServiceTest.java"),
        join(directory, "src/test/java/com/example/orders/OrderRepositoryTest.java"),
      ];
      const metrics = await testBloatMetrics(directory, files, parser);

      expect(metrics.evidence.length).toBeGreaterThan(0);
      for (const entry of metrics.evidence) {
        expect(entry.startLine).toBeGreaterThanOrEqual(1);
        expect(entry.endLine).toBeGreaterThanOrEqual(entry.startLine);
        expect(entry.sample.length).toBeGreaterThan(0);
        expect(entry.file.startsWith(directory)).toBe(false); // 仓库相对路径
      }
      // Java 夹具的共享块是 @BeforeEach + H2 seed：定位到具体行范围与样本文本
      const shared = metrics.evidence.find((entry) => entry.factor === "codeSimilarityRatio");
      expect(shared?.startLine).toBe(25);
      expect(shared?.endLine).toBe(32);
      expect(shared?.sample).toContain("@BeforeEach");
      expect(shared?.sample).toContain("setUp");
    });
  });

  /**
   * 尺寸离散证据的样本必须来自**被计分的那份内容**：审计 §4.2 记录旧实现为了取前两行
   * 又 `readFileSync(maxFile)` 读了一次同一个文件（"同一文件最多读 3 次"里的第三次）。
   * 整改后样本取自统计循环里已读入的 content，并由同一遍的行数决定 maxFile。
   * 21 个文件（P95≠max）+ CRLF 把这个路径钉住：行数统计、maxFile 归属、`/\r?\n/` 归一化。
   */
  it("sizeDispersion evidence samples the largest file from the same read (CRLF 归一化)", async () => {
    await withTemporaryDirectory("bloat-dispersion", async (directory) => {
      const files: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const file = join(directory, `src/small${index}.test.ts`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Array.from({ length: 10 }, (_, line) => `// small ${index} line ${line}`).join("\n"));
        files.push(file);
      }
      const large = join(directory, "src/large.test.ts");
      writeFileSync(large, ["// large line 1", "// large line 2", ...Array.from({ length: 48 }, (_, line) => `// large line ${line + 3}`)].join("\r\n"));
      files.push(large);

      const metrics = await testBloatMetrics(directory, files, parser);
      expect(metrics.sizeDispersion).toBe(5); // max=50 行 / P95=10 行
      const entry = metrics.evidence.find((item) => item.factor === "sizeDispersion");
      expect(entry).toBeDefined();
      expect(entry!.file).toBe("src/large.test.ts");
      expect(entry!.value).toBe(50);
      expect(entry!.detail).toBe("50 行（本套 P95=10）");
      // 样本 = 最大文件前两行，CRLF 按 `/\r?\n/` 归一化为 `\n`
      expect(entry!.sample).toBe("// large line 1\n// large line 2");
    });
  });

  it("guards the all-unavailable case explicitly (no test files ⇒ score 0, no fabricated factors)", async () => {
    await withTemporaryDirectory("bloat-empty", async (directory) => {
      const metrics = await testBloatMetrics(directory, [], parser);
      expect(metrics.availableWeight).toBe(0);
      expect(metrics.score).toBe(0);
      expect(metrics.triggered).toBe(false);
      for (const part of metrics.parts) {
        expect(part).toMatchObject({ availability: "UNAVAILABLE", reason: "no_test_files" });
        expect(part.value).toBeUndefined();
      }
      expect(metrics.evidence).toEqual([]);
    });
  });

  it("以用例体为界：体外装配计分，体内（含断言）不计分（DRY/DAMP 平衡）", async () => {
    await withTemporaryDirectory("bloat-damp", async (directory) => {
      // 两个完全相同的测试文件：前半段是**用例体之外**的装配（`@Mock`/DDL 式声明 + 调用），
      // 后半段是 `it(...)` 用例体，体内既有 arrange 也有断言。
      const setup = [
        "const table = createTable('t');",
        "const columns = ['a', 'b', 'c'];",
        "const ddl = 'create table t (a int, b int, c int)';",
        "execute(ddl);",
      ].join("\n");
      const caseBody = [
        "it('works', () => {",
        "  const row = load(table);",
        "  expect(row.a).toBe(1);",
        "  expect(row.b).toBe(2);",
        "  expect(row.c).toBe(3);",
        "});",
      ].join("\n");
      // 补足行数，使块窗口（8 行）能分别完全落在装配区与用例体内
      const filler = Array.from({ length: 12 }, (_, index) => `const pad${index} = ${index};`).join("\n");
      const body = `${setup}\n${filler}\n\n${caseBody}\n`;
      writeFileSync(join(directory, "a.test.ts"), body);
      writeFileSync(join(directory, "b.test.ts"), body);
      const files = [join(directory, "a.test.ts"), join(directory, "b.test.ts")];

      // 用例体范围：从 `it('works'` 到 `});`（provider 给的是体，不含签名行——这里把体行整段给出）
      const caseStart = body.split("\n").findIndex((line) => line.startsWith("it('works'")) + 2;
      const caseEnd = body.split("\n").length - 1;
      const metrics = await testBloatMetrics(directory, files, parser, {
        availability: "available",
        spans: files.map((file) => ({ file, startLine: caseStart, endLine: caseEnd })),
      });

      // 体外装配 → 计分；体内 → 不计分
      expect(metrics.similarityBuckets.assemblyRatio).toBeGreaterThan(0);
      expect(metrics.similarityBuckets.caseBodyRatio + metrics.similarityBuckets.assertionRatio).toBeGreaterThan(0);
      expect(metrics.similarityBuckets.filesWithoutCaseSpans).toBe(0);
      expect(metrics.similarityBuckets.caseSpansAvailability).toBe("available");
      expect(metrics.codeSimilarityRatio).toBeLessThan(codeSimilarityRatio(files));
      expect(metrics.similarityBuckets.assemblyRatio + metrics.similarityBuckets.unclassifiedRatio)
        .toBeCloseTo(metrics.codeSimilarityRatio ?? 0, 10);
    });
  });

  it("未识别出用例的文件不得被整文件当成装配（体界判据不适用）", async () => {
    await withTemporaryDirectory("bloat-damp-nospan", async (directory) => {
      const declarations = Array.from({ length: 24 }, (_, index) => `const value${index} = ${index};`).join("\n");
      const calls = Array.from({ length: 24 }, (_, index) => `consume(value${index});`).join("\n");
      const body = `${declarations}\n${calls}\n`;
      writeFileSync(join(directory, "a.test.ts"), body);
      writeFileSync(join(directory, "b.test.ts"), body);
      const files = [join(directory, "a.test.ts"), join(directory, "b.test.ts")];

      // spans 为 available 但**没有这两个文件**（provider 未识别出用例）
      const metrics = await testBloatMetrics(directory, files, parser, { availability: "available", spans: [] });

      expect(metrics.similarityBuckets.filesWithoutCaseSpans).toBe(2);
      // 调用块必须落在未分类（计分但未证实），不得被当成装配样板：
      // 无调用点的纯声明块仍可判为装配（那本来就无可争议），关键在于**调用块有自己的桶**。
      expect(metrics.similarityBuckets.unclassifiedRatio).toBeGreaterThan(0);
      expect(metrics.similarityBuckets.assemblyRatio).toBeLessThan(metrics.codeSimilarityRatio ?? 0);
      expect(metrics.similarityBuckets.assemblyRatio + metrics.similarityBuckets.unclassifiedRatio)
        .toBeCloseTo(metrics.codeSimilarityRatio ?? 0, 10);
    });
  });

  it("用例体证据为 partial/unavailable 时如实标注可用性", async () => {
    await withTemporaryDirectory("bloat-damp-partial", async (directory) => {
      writeFileSync(join(directory, "a.test.ts"), "it('a', () => { expect(1).toBe(1); });\n");
      const files = [join(directory, "a.test.ts")];
      const partial = await testBloatMetrics(directory, files, parser, { availability: "partial", reason: "存在未识别文件", spans: [] });
      expect(partial.similarityBuckets.caseSpansAvailability).toBe("partial");
      const notRequested = await testBloatMetrics(directory, files, parser);
      expect(notRequested.similarityBuckets.caseSpansAvailability).toBe("not_requested");
    });
  });

  it("把断言语义重复排除出计分并单列观察值（DRY/DAMP 平衡）", async () => {
    await withTemporaryDirectory("bloat-damp", async (directory) => {
      // 两个完全相同的测试文件：上半段是**无调用**的纯声明（装配样板），下半段是断言序列（测量协议）。
      const declarations = Array.from({ length: 24 }, (_, index) => `const value${index} = ${index};`).join("\n");
      const asserts = Array.from({ length: 24 }, (_, index) => `expect(value${index}).toBe(${index});`).join("\n");
      const body = `${declarations}\n\n${asserts}\n`;
      writeFileSync(join(directory, "a.test.ts"), body);
      writeFileSync(join(directory, "b.test.ts"), body);
      const files = [join(directory, "a.test.ts"), join(directory, "b.test.ts")];

      const metrics = await testBloatMetrics(directory, files, parser);

      // 两类重复都被识别，并分别归类
      expect(metrics.similarityBuckets.assemblyRatio).toBeGreaterThan(0);
      expect(metrics.similarityBuckets.assertionRatio).toBeGreaterThan(0);
      // 断言块不再计入 codeSimilarityRatio：必然低于"未分类、按总量计分"的口径
      expect(metrics.codeSimilarityRatio).toBeLessThan(codeSimilarityRatio(files));
      // 计分分子 = 装配 + 未分类，分母不变 ⇒ 三者关系自洽
      expect(metrics.similarityBuckets.assemblyRatio + metrics.similarityBuckets.unclassifiedRatio)
        .toBeCloseTo(metrics.codeSimilarityRatio ?? 0, 10);
      expect(metrics.similarityBuckets.filesWithoutBlockEvidence).toBe(0);
    });
  });

  it("stays report-only: the metrics surface carries no verdict / policy / exit-code field", async () => {
    await withTemporaryDirectory("bloat-report-only", async (directory) => {
      const metrics = await testBloatMetrics(directory, [], parser);
      for (const key of ["verdict", "policy", "decision", "exitCode", "triggeredPolicy", "gate"]) {
        expect(metrics).not.toHaveProperty(key);
      }
      // triggered 只是观察信号本身，不外泄裁决字段；similarityBuckets 是 DRY/DAMP 观察值（同样不裁决）
      expect(Object.keys(metrics).sort()).toEqual(["availableWeight", "evidence", "parts", "score", "similarityBuckets", "triggered"]);
    });
  });
});
