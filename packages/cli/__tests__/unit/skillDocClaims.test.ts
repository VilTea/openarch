import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commandDefinitions } from "../../src/commands";

const repositoryRoot = resolve(process.cwd(), "..", "..");
const skillFiles = [
  resolve(repositoryRoot, ".agents", "skills", "openarch", "SKILL.md"),
  resolve(repositoryRoot, ".agents", "skills", "openarch", "gate-response.md"),
  resolve(repositoryRoot, ".agents", "skills", "openarch", "record-guide.md"),
  resolve(repositoryRoot, "INSTALL.md"),
  resolve(repositoryRoot, "INSTALL.zh-CN.md"),
];

const knownCommands = new Set(commandDefinitions.map((command) => command.name));
const defaultCommands = new Set(
  commandDefinitions.filter((command) => command.visibility === "default").map((command) => command.name),
);

/** 文档中 `openarch <command>` 的声称（防"文档声称不存在的命令"类漂移）。 */
const claimedCommands = (text: string): readonly string[] => {
  const claims = new Set<string>();
  for (const match of text.matchAll(/openarch\s+([a-z][a-z-]*)/g)) {
    const claimed = match[1];
    if (claimed === "init" || claimed === "context" || claimed === "scan" || claimed === "review"
      || claimed === "check" || claimed === "rules" || claimed === "docs" || claimed === "toolchains"
      || claimed === "coordination" || claimed === "lsp" || claimed === "calibration") {
      claims.add(claimed);
    }
  }
  return [...claims].sort();
};

describe("skill/INSTALL 文档与命令面对齐", () => {
  for (const file of skillFiles) {
    // .agents 源树只在 main 开发分支存在（codex 配置位置）；release 分支无 .agents，
    // 对应文件跳过（INSTALL/README 等发布文件仍校验）。
    it.skipIf(!existsSync(file))(`${file.split(/[\\/]/).slice(-2).join("/")} 声称的命令都存在且可见性一致`, () => {
      const text = readFileSync(file, "utf8");
      const claims = claimedCommands(text);
      for (const claimed of claims) {
        expect(knownCommands.has(claimed), `${file}: 声称的命令 openarch ${claimed} 不存在于 commandDefinitions`).toBe(true);
      }
      // 文档声称"公开命令"时，default 命令必须全部在内（INSTALL 的公开命令面行）
      if (file.includes("INSTALL")) {
        for (const name of defaultCommands) {
          // 列表形态（`openarch init`、`context`、`review`）与全称形态都接受
          const listed = text.includes(`openarch ${name}`) || text.includes(`\`${name}\``);
          expect(listed, `${file}: 公开命令面声称缺 ${name}`).toBe(true);
        }
      }
    });
  }
});
