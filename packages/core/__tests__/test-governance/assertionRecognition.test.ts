// 认知点原则（§3.2）：断言识别的唯一权威。
// 本文件锁定 ../src/test-governance/assertionRecognition 的公开事实，
// 防止名单/注解规则再次在 provider 与跨文件解析里分叉。
import { describe, expect, it } from "vitest";
import {
  JUNIT_ASSERTION_METHODS, MOCKITO_VERIFICATION_METHODS,
  assertionSyntaxLanguageFor, blockEvidenceQueryFor, classifyBlockSemantics,
  declaresExpectedFailure, isJunitAssertionMethod, isJunitImport, isMockitoImport, isMockitoVerificationMethod,
} from "../../src/test-governance/assertionRecognition";

describe("assertionRecognition（断言识别唯一权威）", () => {
  it("holds exactly the 14 standard JUnit assertion methods", () => {
    expect([...JUNIT_ASSERTION_METHODS].sort()).toEqual([
      "assertArrayEquals", "assertDoesNotThrow", "assertEquals", "assertFalse", "assertIterableEquals",
      "assertNotEquals", "assertNotNull", "assertNotSame", "assertNull", "assertSame", "assertThat",
      "assertThrows", "assertTrue", "fail",
    ]);
  });

  it("holds the Mockito verification family and keeps the JUnit/Mockito namespaces disjoint", () => {
    expect([...MOCKITO_VERIFICATION_METHODS].sort()).toEqual([
      "verify", "verifyNoInteractions", "verifyNoMoreInteractions", "verifyZeroInteractions",
    ]);
    expect(isMockitoVerificationMethod("verifyNoInteractions")).toBe(true);
    expect(isJunitAssertionMethod("verify")).toBe(false);
    expect(isJunitAssertionMethod("assertEquals")).toBe(true);
    expect(isJunitAssertionMethod(undefined)).toBe(false);
  });

  it("recognises JUnit/Mockito imports including static imports", () => {
    expect(isJunitImport("import org.junit.jupiter.api.Test;")).toBe(true);
    expect(isJunitImport("import static org.junit.jupiter.api.Assertions.assertEquals;")).toBe(true);
    expect(isJunitImport("import com.example.junitlike.Test;")).toBe(false);
    expect(isMockitoImport("import static org.mockito.Mockito.verify;")).toBe(true);
    expect(isMockitoImport("import org.mockito.ArgumentMatchers;")).toBe(true);
    expect(isMockitoImport("import com.example.mockito.Verify;")).toBe(false);
  });

  it("reads @Test(expected = X.class) regardless of spacing, qualification and extra arguments", () => {
    expect(declaresExpectedFailure("@Test(expected = IllegalStateException.class)")).toBe(true);
    expect(declaresExpectedFailure("@Test(expected=IllegalStateException.class)")).toBe(true);
    expect(declaresExpectedFailure("@Test( expected = IllegalStateException.class )")).toBe(true);
    expect(declaresExpectedFailure("@Test(timeout = 1000, expected = IllegalStateException.class)")).toBe(true);
    expect(declaresExpectedFailure("@org.junit.Test(expected = IllegalStateException.class)")).toBe(true);
    expect(declaresExpectedFailure("@Disabled @Test(expected = IllegalStateException.class)")).toBe(true);
    // 无 expected 参数或根本不是参数化注解 ⇒ 不声明期望异常
    expect(declaresExpectedFailure("@Test")).toBe(false);
    expect(declaresExpectedFailure("@Test(timeout = 1000)")).toBe(false);
    expect(declaresExpectedFailure("@Test void t() { service.call(); }")).toBe(false);
    expect(declaresExpectedFailure("")).toBe(false);
  });
});

describe("块语义分类（DRY/DAMP 平衡的唯一判据）", () => {
  const evidence = (assertion: readonly number[], calls: readonly number[], caseBody?: readonly number[]) => ({
    assertionLines: new Set(assertion),
    callLines: new Set(calls),
    ...(caseBody ? { caseBodyLines: new Set(caseBody) } : {}),
  });

  it("含已识别断言调用点的块归 assertion（DAMP 侧，不计分）", () => {
    expect(classifyBlockSemantics({ startLine: 10, endLine: 17 }, evidence([12], [11, 12, 13]))).toBe("assertion");
  });

  it("有用例体证据时：完全在用例体之外才是 assembly（装配样板，计分）", () => {
    expect(classifyBlockSemantics({ startLine: 1, endLine: 8 }, evidence([], [], [30, 31, 32]))).toBe("assembly");
  });

  it("有用例体证据时：与用例体相交即 case-body（测试语义，不计分）——跨边界也算相交", () => {
    expect(classifyBlockSemantics({ startLine: 30, endLine: 37 }, evidence([], [33], [30, 31, 32]))).toBe("case-body");
    // 跨"签名/体首"边界：只要与体相交就归测试语义（宁可少扣分）
    expect(classifyBlockSemantics({ startLine: 26, endLine: 33 }, evidence([], [33], [30, 31, 32]))).toBe("case-body");
  });

  it("没有用例体证据时退回弱判据：无调用点记 assembly，有调用记 unclassified（仍计分但未证实）", () => {
    expect(classifyBlockSemantics({ startLine: 1, endLine: 8 }, evidence([], []))).toBe("assembly");
    expect(classifyBlockSemantics({ startLine: 20, endLine: 27 }, evidence([], [22, 23]))).toBe("unclassified");
  });

  it("断言优先于用例体：两者都命中时归 assertion（给出更具体的信号）", () => {
    expect(classifyBlockSemantics({ startLine: 30, endLine: 37 }, evidence([33], [33], [30, 31, 32]))).toBe("assertion");
  });

  it("只认块区间内的行：相邻块的行不得越界影响", () => {
    expect(classifyBlockSemantics({ startLine: 10, endLine: 17 }, evidence([18], [18], [30]))).toBe("assembly");
    expect(classifyBlockSemantics({ startLine: 18, endLine: 25 }, evidence([18], [18], [30]))).toBe("assertion");
  });

  it("语言映射是同一权威：跨文件 helper 解析与块语义分类不会分叉", () => {
    expect(assertionSyntaxLanguageFor("A.java")).toBe("java");
    expect(assertionSyntaxLanguageFor("a.py")).toBe("python");
    expect(assertionSyntaxLanguageFor("a.tsx")).toBe("ts");
    expect(assertionSyntaxLanguageFor("a.go")).toBeUndefined();
    expect(assertionSyntaxLanguageFor("a.rs")).toBeUndefined();
  });

  it("Java 的断言名集合含 JUnit 与 Mockito，TS 宽口径覆盖成员调用，Python 用 assert 语句", () => {
    const java = blockEvidenceQueryFor("java");
    expect(java.isAssertionName("assertEquals")).toBe(true);
    expect(java.isAssertionName("verify")).toBe(true);
    expect(java.isAssertionName("save")).toBe(false);
    expect(java.namedCallPattern).toBeDefined();
    // Python 的 assert 是语句：额外一条查询，名字判定恒 false
    const python = blockEvidenceQueryFor("python");
    expect(python.statementAssertionPattern).toBeDefined();
    expect(python.isAssertionName("assertEqual")).toBe(false);
    // TS 只认 expect/assert，且**宽口径必须覆盖成员调用**（否则 `service.save(x)` 会被当成无调用块）
    const ts = blockEvidenceQueryFor("ts");
    expect(ts.isAssertionName("expect")).toBe(true);
    expect(ts.isAssertionName("assert")).toBe(true);
    expect(ts.isAssertionName("mkdirSync")).toBe(false);
    expect(ts.callPattern).toBe("(call_expression) @call");
    expect(ts.namedCallPattern).toBeDefined();
    expect(ts.statementAssertionPattern).toBeUndefined();
  });
});
