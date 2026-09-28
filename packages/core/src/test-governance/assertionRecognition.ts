/**
 * JUnit / Mockito 断言识别的唯一权威（认知点原则 §3.2）。
 *
 * 修复缺陷 2 时确认：14 个标准 JUnit 断言方法名曾经在
 * `providers/junit.ts` 与 `assertionContext.ts` 各写一份（平行实现），
 * 且跨文件 helper 路径不认识 Mockito `verify` 家族 ⇒ 把"什么算断言"
 * 收敛到本模块，provider 与跨文件 helper 解析都只消费这里。
 *
 * 边界纪律：本模块只做"名字/注解/import 文本"这一层语法事实，不做语义推断；
 * 是否启用 Mockito 名字由调用方按 import 门控（同 `junit.ts` 既有做法）。
 */

/** 标准 JUnit 4/5 断言方法族（Assertions/Assert/Hamcrest 的常用面）——唯一权威。 */
export const JUNIT_ASSERTION_METHODS: ReadonlySet<string> = new Set([
  "assertEquals", "assertNotEquals", "assertTrue", "assertFalse", "assertNull", "assertNotNull",
  "assertSame", "assertNotSame", "assertThrows", "assertThat", "assertArrayEquals",
  "assertDoesNotThrow", "assertIterableEquals", "fail",
]);

/** Mockito 验证方法族——唯一权威。`verify(...).foo(...)` 是有效行为断言（2026-08-14 P1-3）。 */
export const MOCKITO_VERIFICATION_METHODS: ReadonlySet<string> = new Set([
  "verify", "verifyNoInteractions", "verifyNoMoreInteractions", "verifyZeroInteractions",
]);

/**
 * JUnit 4 **`@Rule` 委托式**断言方法族（唯一权威，2026-09-25 实地核实 D-G1）。
 *
 * 缺陷：`thrown.expect(X.class)` / `expectMessage(...)` / `expectCause(...)`、
 * `collector.checkThat(...)` / `checkSucceeds(...)` / `addError(...)` 都是 JUnit 4
 * 官方断言 API，但断言被**委托给规则对象**，测试体内没有 `assert*` 调用，于是被判
 * `missing_assertion`。在 JUnit 自己的套件上实测 **52 条误报**
 * （`ErrorCollectorTest` 16、`ExpectedExceptionTest` 22、…）。
 *
 * 门控条件是**同一文件声明了 `@Rule`/`@ClassRule`**（{@link declaresJunitRule}）：
 * 与既有 `mockitoImported` 门控同一形状（都是"文件级事实 + 方法名"这一证据层），
 * 不引入字段级语义推断。方向安全——`@Rule` 存在而误认一个同名方法只会**少报** finding；
 * 反过来漏识别会误报（本缺陷）。
 *
 * 有意保留的边界（不猜）：
 * - assumptions（`Assume.assumeTrue/assumeFalse/assumeThat`、JUnit 5 `assumeTrue`）**不算**断言：
 *   它是前置条件而非验证，`assumeTrue(false)` 的语义是"跳过这个用例"。
 *   实测语料 `junit/tests/runner/ResultTest#assumptionFailed` 体里只有 `Assume.assumeTrue(false)`，
 *   按"该用例没有断言"报告是**正确**的；该用例验证的是 assumption 管道，由外层测试断言。
 * - 第三方规则/自定义 `TestRule` 的任意方法名（无语义权威可比对）不识别。
 */
export const JUNIT_RULE_ASSERTION_METHODS: ReadonlySet<string> = new Set([
  "expect", "expectMessage", "expectCause", "checkThat", "checkSucceeds", "addError",
]);

/** 名字是否为 `@Rule` 委托式断言方法（调用方负责按"文件声明了 @Rule"门控）。 */
export const isJunitRuleAssertionMethod = (name: string | undefined): boolean =>
  name !== undefined && JUNIT_RULE_ASSERTION_METHODS.has(name);

/** 修饰符/注解文本是否声明了 JUnit 4 的规则成员（`@Rule` / `@ClassRule`，含限定名）。 */
export const declaresJunitRule = (modifiersText: string): boolean =>
  /@(?:[\w.]+\.)?(?:Rule|ClassRule)\b/.test(modifiersText);

/** 名字是否为标准 JUnit 断言方法。 */
export const isJunitAssertionMethod = (name: string | undefined): boolean =>
  name !== undefined && JUNIT_ASSERTION_METHODS.has(name);

/**
 * **低信息量（弱）** 断言的唯一权威：只检查存在性/布尔，失败信息无法定位具体值。
 *
 * 用途：`weakAssertionRatio`（测试膨胀因子）的分子。与各语法族的断言名单是**子集关系**
 * （分母是该族的断言调用点），因此新增弱断言只改这里，探针 regex 由本集合**派生**
 * （`testBloatMetrics` 只 join 名单，不手抄名字 ⇒ 不可能漂移）。
 *
 * 为什么按语法族分列而不是一个并集：两族的 tree-sitter 调用形状不同
 * （Java `method_invocation` / TS 链式 `member_expression`），合并会掩盖形状差异。
 *
 * 有意边界：`assertThat(x, notNullValue())` 语义上同样是弱断言，但那是**匹配器**层的事实，
 * 名字级判据看不到；把它算进来需要解析第二个实参（本模块声明只做名字/注解/import 文本
 * 这一层）。漏计方向 = 少报弱断言，不制造假阳性。
 */
export const WEAK_JUNIT_ASSERTION_METHODS: ReadonlySet<string> = new Set([
  "assertNotNull", "assertTrue", "assertFalse",
]);

/**
 * TS/JS 系的弱断言匹配器名（Jest/Vitest）。链式调用形状，见 `testBloatMetrics`。
 *
 * **只收有官方出处的名字**（2026-09-27，`整改变更说明` §6.2 #3 ⑤）：`toBeTruthy` / `toBeFalsy`
 * 是 Jest/Vitest 文档里 "truthiness" 一族的成员。此前收的 `toBeDefined` **没有权威依据**
 * —— 它是"非空/非 undefined"检查，不是弱断言的官方定义；实测它贡献了本仓该因子的**绝大部分**
 * 分子（现状 `toBeTruthy`+`toBeDefined` = 0.00857 vs 官方集合 = 0.00161，相差 5.3×；
 * 本仓测试文本计数 `toBeDefined` 27 次、`toBeFalsy` 0 次）⇒ 对齐官方集合会让 TS/JS 项目的
 * `weakAssertionRatio` **下降**（更少用例被判"全部断言皆弱"），属**事实口径变化**；阈值 0.03
 * 维持不变（下降方向只会更不容易触发，收紧阈值需跨项目样本）。
 * 删除名单项比"留着没依据的项"更符合本因子初衷：分子只统计**可证明**的弱断言。
 */
export const WEAK_TS_ASSERTION_METHODS: ReadonlySet<string> = new Set([
  "toBeTruthy", "toBeFalsy",
]);

/** 名字是否为 Mockito 验证方法（调用方负责按 import 门控）。 */
export const isMockitoVerificationMethod = (name: string | undefined): boolean =>
  name !== undefined && MOCKITO_VERIFICATION_METHODS.has(name);

/** import 声明文本是否引入 JUnit（`org.junit...`，含 static import）。 */
export const isJunitImport = (importText: string): boolean =>
  /\b(?:static\s+)?org\.junit(?:\.|;)/.test(importText);

/** import 声明文本是否引入 Mockito（`org.mockito...`，含 static import）。 */
export const isMockitoImport = (importText: string): boolean =>
  /\b(?:static\s+)?org\.mockito(?:\.|;)/.test(importText);

/**
 * 注解级验证意图的唯一权威（缺陷 2）：JUnit 4 `@Test(expected = X.class)`。
 * 任意空白（`expected=X.class`）与限定注解名（`@org.junit.Test(...)`）都识别；
 * `@Test(timeout = 1000, expected = X.class)` 这类多参数形式同样覆盖。
 *
 * 有意记录的边界（不猜）：
 * - `@Rule ExpectedException` **已由 {@link JUNIT_RULE_ASSERTION_METHODS} 覆盖**（2026-09-25 D-G1）：
 *   判据是"文件声明了 `@Rule` + 体内有 `expect/expectMessage/checkThat/...` 调用"，
 *   不再需要字段级类型推断；此处保留说明以免读者以为它仍未实现。
 * - JUnit 5 `assertThrows` 是方法体调用，已由 {@link JUNIT_ASSERTION_METHODS} 覆盖；
 * - 第三方异常断言注解不在本规则内（缺少可比对的语法权威）。
 */
const expectedFailureAnnotation = /@(?:[\w.]+\.)?Test\s*\([^)]*?\bexpected\s*=/;

/** 修饰符文本是否声明了 JUnit 4 的期望异常（注解参数 `expected`）。 */
export const declaresExpectedFailure = (modifiersText: string): boolean =>
  expectedFailureAnnotation.test(modifiersText);

/** 能做块语义分类的语言（与 test provider 覆盖面一致）。 */
export type AssertionSyntaxLanguage = "ts" | "java" | "python";

/** 语言 → 源码扩展名判定。**唯一权威**：跨文件 helper 解析与块语义分类共用同一映射。 */
export const assertionSyntaxLanguageFor = (path: string): AssertionSyntaxLanguage | undefined =>
  path.endsWith(".java") ? "java"
    : path.endsWith(".py") ? "python"
      : /\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/i.test(path) ? "ts"
        : undefined;

/**
 * 块语义分类的**唯一权威**（校准 2026-09-25，DRY/DAMP 平衡）。
 *
 * 缺陷：`codeSimilarityRatio` 只看到"两段文本相似"，无从区分
 * 「装配/管线样板」（应 DRY）与「断言/测量协议」（应 DAMP）。于是它把断言重复也计成"该抽"，
 * 单向把测试推向 DRY。
 *
 * 判定的**正向依据**是 provider 确认的**用例体范围**（`test-case-spans` 事实域）：
 * 与用例体相交的块是测试语义（DAMP），完全在用例体之外的块才是装配样板（可 DRY）。
 * 断言调用名是额外的、更细的信号（用于指出"这段重复是断言"）。
 *
 * - `assertion`：块内出现已识别的断言/验证调用点 ⇒ DAMP 侧，**不计分**；
 * - `case-body`：块与某个已识别用例体相交 ⇒ 测试语义，**不计分**；
 * - `assembly`：块完全在用例体之外 ⇒ 唯一可证明的装配样板，**计分**；
 * - `unclassified`：该文件**没有**用例体证据（provider 未识别出用例）⇒ 退回"有无调用点"的弱判据：
 *   有调用则不计入 `assembly` 而记 `unclassified`（仍计分但标注未证实），无调用才记 `assembly`。
 *
 * 为什么 `unclassified` 仍计分：真实装配样板**几乎都带调用**（仓库自身 fixture 就是
 * `mkdtempSync`/`writeFileSync`）；把它们一律排除会让装配通道变空——那是取消指标而不是平衡。
 * 反过来，若把"没有用例证据的文件"整文件当装配，就会把测试体重复计成 DRY，方向错误，
 * 因此**只有至少识别出一个用例的文件才启用体界判据**，其余走 `unclassified` 并如实标边界。
 */
export type BlockSemantics = "assertion" | "case-body" | "assembly" | "unclassified";

export interface BlockLineEvidence {
  /** 1-based：已识别断言/验证调用点的行集合。 */
  readonly assertionLines: ReadonlySet<number>;
  /** 1-based：任意调用点的行集合（含断言调用点）。 */
  readonly callLines: ReadonlySet<number>;
  /**
   * 1-based：该文件内 provider 确认的**用例体行**（不含签名/注解行）。
   * **缺省表示该文件没有可用证据**（未识别出用例），此时不启用体界判据。
   */
  readonly caseBodyLines?: ReadonlySet<number>;
}

/** 行区间是否与给定行集合相交（区间与集合都用 1-based 行号）。 */
const intersects = (startLine: number, endLine: number, lines: ReadonlySet<number>): boolean => {
  for (let line = startLine; line <= endLine; line++) if (lines.has(line)) return true;
  return false;
};

/** 块语义：断言 → 用例体 → （无体界证据时）有无调用点。跨边界的块按"相交即测试语义"处理。 */
export const classifyBlockSemantics = (
  range: { readonly startLine: number; readonly endLine: number },
  evidence: BlockLineEvidence,
): BlockSemantics => {
  const endLine = Math.max(range.startLine, range.endLine);
  if (intersects(range.startLine, endLine, evidence.assertionLines)) return "assertion";
  if (evidence.caseBodyLines) {
    return intersects(range.startLine, endLine, evidence.caseBodyLines) ? "case-body" : "assembly";
  }
  return intersects(range.startLine, endLine, evidence.callLines) ? "unclassified" : "assembly";
};

/** 块语义证据所需的查询。 */
export interface BlockEvidenceQuery {
  /** 宽口径：**任意**调用点（含成员调用），用于"这个块有没有调用"。 */
  readonly callPattern: string;
  /** 窄口径：能取到 callee 名字的调用（用于按名单判定断言）；缺省表示该语言无此形态。 */
  readonly namedCallPattern?: string;
  /** Python 的 `assert` 是语句不是调用，需要额外一条。 */
  readonly statementAssertionPattern?: string;
  /** 调用名是否算断言/验证（Java 的 Mockito 家族刻意不做 import 门控：误判只会**少扣分**，方向安全）。 */
  readonly isAssertionName: (name: string | undefined) => boolean;
}

export const blockEvidenceQueryFor = (language: AssertionSyntaxLanguage): BlockEvidenceQuery =>
  language === "java"
    ? {
      callPattern: "(method_invocation) @call",
      namedCallPattern: "(method_invocation name: (identifier) @name) @call",
      isAssertionName: (name) => isJunitAssertionMethod(name) || isMockitoVerificationMethod(name),
    }
    : language === "python"
      ? {
        callPattern: "(call) @call",
        statementAssertionPattern: "(assert_statement) @call",
        isAssertionName: () => false,
      }
      : {
        // 宽口径必须覆盖成员调用：`service.save(x)` 也是调用点，漏掉它会把测试体误判成装配块。
        callPattern: "(call_expression) @call",
        namedCallPattern: "(call_expression function: (identifier) @name) @call",
        isAssertionName: (name) => name === "expect" || name === "assert",
      };
