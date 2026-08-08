import { describe, expect, it } from "vitest";
import { planLspStart, type LspStartPlan } from "../../src/commands/lsp";

const javaState = { configured: ["java"], detected: [], configExists: true };
const unconfiguredState = { configured: undefined, detected: ["java"], configExists: true };
const noJavaState = { configured: undefined, detected: ["typescript"], configExists: true };
const bareState = { configured: undefined, detected: [], configExists: false };

describe("planLspStart（语言门禁 / 提醒 / fail-soft 纯决策）", () => {
  it("拒绝非 java 的 --lang", () => {
    const plan = planLspStart({ lang: "rust", languageState: javaState, daemonRunning: false, launchAvailable: true, owner: "manual" });
    expect(plan).toMatchObject({ outcome: "unsupported-lang", exit: 3 });
  });

  it("非 java 项目跳过（exit 0）", () => {
    const plan = planLspStart({ lang: "java", languageState: noJavaState, daemonRunning: false, launchAvailable: true, owner: "manual" });
    expect(plan).toMatchObject({ outcome: "skip-lang", exit: 0 });
    expect(plan.message).toContain("项目未使用 java");
  });

  it("已初始化但未声明 languages 时带提醒（非阻塞）", () => {
    const plan = planLspStart({ lang: "java", languageState: unconfiguredState, daemonRunning: false, launchAvailable: true, owner: "manual" });
    expect(plan.reminder).toContain("未声明 languages");
    expect(plan.outcome).toBe("start");
  });

  it("daemon 已运行直接返回（幂等）", () => {
    const plan = planLspStart({ lang: "java", languageState: javaState, daemonRunning: true, launchAvailable: true, owner: "manual" });
    expect(plan).toMatchObject({ outcome: "already-running", exit: 0 });
  });

  it("工具链缺失：harness fail-soft（exit 0），manual fail-closed（exit 3）", () => {
    const harness = planLspStart({ lang: "java", languageState: javaState, daemonRunning: false, launchAvailable: false, owner: "reasonix" });
    expect(harness).toMatchObject({ outcome: "skip-toolchain", exit: 0 });
    expect(harness.message).toContain("harness(reasonix) 环境跳过");

    const manual = planLspStart({ lang: "java", languageState: javaState, daemonRunning: false, launchAvailable: false, owner: "manual" });
    expect(manual).toMatchObject({ outcome: "skip-toolchain", exit: 3 });
  });

  it("未初始化项目（无 config）不提醒、按检测语言门禁", () => {
    const plan = planLspStart({ lang: "java", languageState: bareState, daemonRunning: false, launchAvailable: true, owner: "manual" });
    expect(plan.reminder).toBeUndefined();
    expect(plan).toMatchObject({ outcome: "skip-lang", exit: 0 });
  });

  it("就绪时 outcome=start", () => {
    const plan: LspStartPlan = planLspStart({ lang: "java", languageState: javaState, daemonRunning: false, launchAvailable: true, owner: "manual" });
    expect(plan.outcome).toBe("start");
    expect(plan.exit).toBe(0);
  });
});
