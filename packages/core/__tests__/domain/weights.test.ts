import { describe, it, expect } from "vitest";
import { LAMBDA_AST } from "../../src/domain/weights";

describe("LAMBDA_AST 权重表", () => {
  it("接口变更 = 100（design §7.2）", () => {
    expect(LAMBDA_AST.interface_add_remove).toBe(100);
  });
  it("函数体变更 = 10", () => {
    expect(LAMBDA_AST.function_body).toBe(10);
  });
  it("注释/空白 = 0", () => {
    expect(LAMBDA_AST.comment_whitespace).toBe(0);
  });
  it("接口 vs 函数体 = 10:1 比例", () => {
    expect(LAMBDA_AST.interface_add_remove / LAMBDA_AST.function_body).toBe(10);
  });
});
