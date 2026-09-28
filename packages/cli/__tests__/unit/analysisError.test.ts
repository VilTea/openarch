import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printAnalysisError } from "../../src/runtime";

/**
 * F-E（2026-09-27 独立复验，真实 CLI e2e 复现）：`printAnalysisError` 此前**只读 `cause`**，
 * 于是
 * - `Effect.fail(new Error("…"))`（`message` 里才是人话）⇒ 打印 `分析失败 [UnknownError]`，
 * - 手写标记错误（`GateConfigurationError` 把原因放在 `reason`）⇒ 同样丢掉，
 * 用户只看到一个标签，**原因整句消失**，无从知道该重建 baseline 还是改配置。
 *
 * 这三条锁住兜底顺序 `cause` → `reason` → `message`，且不把已有的 `cause` 优先级弄反。
 */
describe("printAnalysisError（退出码/原因渲染）", () => {
  const captured: string[] = [];
  beforeEach(() => {
    captured.length = 0;
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { captured.push(String(line)); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders the reason of a tagged configuration error (scan 的非法 config 路径)", () => {
    const reason = "invalid shapes declaration: shapes.python is not yet wired in this version";
    const error = Object.assign(new Error(reason), {
      _tag: "GateConfigurationError", path: ".openarch/config.yml", reason,
    });
    printAnalysisError(error, "zh");
    expect(captured[0]).toContain("GateConfigurationError");
    expect(captured[0]).toContain(reason);
  });

  it("falls back to message when there is neither cause nor reason", () => {
    printAnalysisError(new Error("plain failure reason"), "zh");
    expect(captured[0]).toContain("plain failure reason");
  });

  it("keeps cause precedence when a cause is present", () => {
    printAnalysisError({ _tag: "IoError", path: "x", cause: new Error("disk exploded") }, "zh");
    expect(captured[0]).toContain("IoError");
    expect(captured[0]).toContain("disk exploded");
  });
});
