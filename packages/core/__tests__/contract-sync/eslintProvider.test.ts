import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const lint = (code: string, filePath: string) =>
  new ESLint({ cwd: root, overrideConfigFile: join(root, "eslint.config.mjs") }).lintText(code, { filePath: join(root, filePath) });

describe("TS/JS contract-sync ESLint provider", () => {
  it("warns on a complete inline P95Values shadow type", async () => {
    const [result] = await lint("type Shadow = { branch: number; nesting: number; loc: number; alpha: number; connectedness: number; externalPassthrough: number; oneMinusConnectedness: number };", "packages/core/src/adapter/shadow.ts");
    expect(result.messages).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "openarch/no-inline-p95-values", severity: 1 })]));
  });

  it("allows a named partial projection", async () => {
    const [result] = await lint("type P95DisplayProjection = { branch: number; loc: number };", "packages/core/src/adapter/projection.ts");
    expect(result.messages).toHaveLength(0);
  });

  it("rejects JavaScript CLI access to an individual P95 field", async () => {
    const [result] = await lint("const n = report.p95.connectedness;", "packages/cli/bin/render.js");
    expect(result.messages).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "openarch/no-cli-p95-field", severity: 2 })]));
  });

  it("warns on parallel language fact tables outside the registration authority", async () => {
    const code = "const map = { typescript: ['.ts', '.tsx'], javascript: ['.js', '.jsx'], go: ['.go'] }; const indicators = ['go.mod'];";
    const [result] = await lint(code, "packages/cli/src/runtime.ts");
    expect(result.messages).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "openarch/no-inline-language-facts", severity: 1 })]));
  });

  it("allows language facts inside the registration authority file", async () => {
    const code = "export const supports = [{ id: 'typescript', extensions: ['.ts', '.tsx'] }, { id: 'javascript', extensions: ['.js', '.jsx'] }, { id: 'go', extensions: ['.go'], projectIndicators: ['go.mod'] }];";
    const [result] = await lint(code, "packages/core/src/adapter/parser/LanguageRegistry.ts");
    expect(result.messages).toHaveLength(0);
  });

  it("warns on direct source globbing outside projectFiles authority", async () => {
    const code = "const files = globSync('packages/**/*.ts');";
    const [result] = await lint(code, "packages/core/src/application/discover.ts");
    expect(result.messages).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "openarch/no-direct-source-glob", severity: 1 })]));
  });

  it("allows direct source globbing inside the projectFiles authority owner", async () => {
    const code = "const files = globSync('**/*.ts');";
    const [result] = await lint(code, "packages/core/src/projectFiles.ts");
    expect(result.messages).toHaveLength(0);
  });
});
