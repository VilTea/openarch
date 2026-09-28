import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { parseJavaText } from "../../src/adapter/parser/JavaStrategy";
import { parseRustText } from "../../src/adapter/parser/RustStrategy";
import { parseTsText } from "../../src/adapter/parser/TsStrategy";
import { analyzeSemanticChanges } from "../../src/domain/semanticChanges";

/**
 * 成员可见性的语言语义回归（认知点原则：可见性只有唯一权威入口，
 * 语言只通过 `DeclarationVisibilityContext` 提供参数）。
 *
 * 0.1.5 的缺陷：共享遍历把外层类型的可见性无条件继承给成员，
 * 而 `isPublic: (node, inherited) => inherited || hasPublicModifier(node)` 让
 * 公有类里的 private / protected / 包级私有成员全部被当作 public，
 * 于是“为降低分支而新增的私有助手”被报成公共合同变更（public_method_sig，λ 60 而非 10/50）。
 *
 * 关键区别：
 *   TypeScript 类成员默认 public  → 继承外层可见性
 *   Java/Rust 成员默认私有        → 只依据显式修饰符（接口/trait 成员除外）
 */

const javaPublicSurface = `package demo;
public class Svc {
    public void existing() { }
    private static void priv() { }
    static void pkg() { }
    protected void prot() { }
}`;

const javaInterfaceSurface = `package demo;
public class Svc {
    public interface Api { void ifaceMethod(); }
}`;

const javaPackagePrivateClass = `package demo;
class Internal {
    void helper() { }
}`;

describe("声明可见性：语言语义不共享“继承公有性”这一错误默认", () => {
  it("Java：公有类里的 private/protected/包级私有方法都不是公共合同", async () => {
    const ast = await Effect.runPromise(parseJavaText("Svc.java", javaPublicSurface));
    const byId = new Map((ast.semanticSurface?.declarations ?? []).map((d) => [d.id, d]));
    expect(byId.get("Svc")?.isPublic).toBe(true);
    expect(byId.get("Svc.existing")?.isPublic).toBe(true);
    expect(byId.get("Svc.priv")?.isPublic).toBe(false);
    expect(byId.get("Svc.pkg")?.isPublic).toBe(false);
    expect(byId.get("Svc.prot")?.isPublic).toBe(false);
  });

  it("Java：新增私有助手归类为 function_sig，而不是 public_method_sig", async () => {
    const before = await Effect.runPromise(parseJavaText("Svc.java", "package demo;\npublic class Svc { public void existing() { } }"));
    const after = await Effect.runPromise(parseJavaText("Svc.java", javaPublicSurface));
    const analysis = analyzeSemanticChanges(before, after);
    expect(analysis.availability).toBe("available");
    const kinds = new Map(analysis.changes.map((change) => [change.anchor, change.kind]));
    expect(kinds.get("Svc.priv")).toBe("function_sig");
    expect(kinds.get("Svc.pkg")).toBe("function_sig");
    expect(kinds.get("Svc.prot")).toBe("function_sig");
    expect([...kinds.values()]).not.toContain("public_method_sig");
  });

  it("Java：接口成员仍是隐式 public（继承只对 interface 容器成立）", async () => {
    const ast = await Effect.runPromise(parseJavaText("Svc.java", javaInterfaceSurface));
    const byId = new Map((ast.semanticSurface?.declarations ?? []).map((d) => [d.id, d]));
    expect(byId.get("Svc.Api")?.isPublic).toBe(true);
    expect(byId.get("Svc.Api.ifaceMethod")?.isPublic).toBe(true);
  });

  it("Java：包级私有类的成员不因外层而变成公共合同", async () => {
    const ast = await Effect.runPromise(parseJavaText("Internal.java", javaPackagePrivateClass));
    const byId = new Map((ast.semanticSurface?.declarations ?? []).map((d) => [d.id, d]));
    expect(byId.get("Internal")?.isPublic).toBe(false);
    expect(byId.get("Internal.helper")?.isPublic).toBe(false);
  });

  it("Rust：pub struct 的私有字段不是公开面，pub 字段仍是", async () => {
    const ast = await Effect.runPromise(parseRustText("a.rs", "pub struct S { pub shown: u32, hidden: u32 }\n"));
    const byId = new Map((ast.semanticSurface?.declarations ?? []).map((d) => [d.id, d]));
    expect(byId.get("S")?.isPublic).toBe(true);
    expect(byId.get("S.shown")?.isPublic).toBe(true);
    expect(byId.get("S.hidden")?.isPublic).toBe(false);
  });

  it("TypeScript：类成员默认 public，private/protected 不是（与 Java 语义相反）", async () => {
    const ast = await Effect.runPromise(parseTsText("a.ts", "export class C { private a = 1; protected b = 2; c = 3; }\n"));
    const byId = new Map((ast.semanticSurface?.declarations ?? []).map((d) => [d.id, d]));
    expect(byId.get("C")?.isPublic).toBe(true);
    expect(byId.get("C.a")?.isPublic).toBe(false);
    expect(byId.get("C.b")?.isPublic).toBe(false);
    expect(byId.get("C.c")?.isPublic).toBe(true);
  });
});
