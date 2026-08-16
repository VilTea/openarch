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
  resolve(repositoryRoot, "README.md"),
  resolve(repositoryRoot, "README.zh-CN.md"),
  resolve(repositoryRoot, "site", "openarch-usage-guide.html"),
];

const knownCommands = new Set(commandDefinitions.map((command) => command.name));
const defaultCommands = new Set(
  commandDefinitions.filter((command) => command.visibility === "default").map((command) => command.name),
);

/** 文档中 `openarch <command>` 的声称（防"文档声称不存在的命令"类漂移）。 */
const claimedCommands = (text: string): readonly string[] => {
  const claims = new Set<string>();
  for (const match of text.matchAll(/openarch\s+([a-z][a-z-]*)/g)) {
    if (knownCommands.has(match[1])) claims.add(match[1]);
  }
  return [...claims].sort();
};

/** 命令面文档（README/INSTALL/site 手册）必须以 commandDefinitions 为唯一口径。 */
const isCommandSurfaceDoc = (file: string): boolean =>
  file.includes("INSTALL") || file.includes("README") || file.includes("openarch-usage-guide.html");

const listedInSurfaceDoc = (file: string, text: string, name: string): boolean => {
  // README/INSTALL 的命令块：Public/公开 commands 与 Advanced/高级 commands 两行内的裸命令名。
  const surfaceLines = text.split(/\r?\n/).filter((line) =>
    /public commands|公开命令|advanced commands|高级命令/i.test(line));
  const blockNames = new Set(surfaceLines.flatMap((line) =>
    [...line.matchAll(/([a-z][a-z-]*)/g)].map((match) => match[1])).filter((token) => knownCommands.has(token)));
  return blockNames.has(name)
    || text.includes(`openarch ${name}`)
    || text.includes(`\`${name}\``)
    || (file.includes("openarch-usage-guide.html") && text.includes(`class="cname">${name}</div>`));
};

describe("skill/文档 与命令注册表对齐", () => {
  for (const file of skillFiles) {
    // .agents 源树只在 main 开发分支存在（codex 配置位置）；release 分支无 .agents，
    // 对应文件跳过（INSTALL/README/site 等发布文件仍校验）。
    it.skipIf(!existsSync(file))(`${file.split(/[\\/]/).slice(-2).join("/")} 声称的命令都存在且可见性一致`, () => {
      const text = readFileSync(file, "utf8");
      const claims = claimedCommands(text);
      for (const claimed of claims) {
        expect(knownCommands.has(claimed), `${file}: 声称的命令 openarch ${claimed} 不存在于 commandDefinitions`).toBe(true);
      }
      // 命令面文档必须覆盖注册表的完整公开/高级命令集合（README/INSTALL/site 三处同一口径）。
      if (isCommandSurfaceDoc(file)) {
        for (const name of commandDefinitions.map((command) => command.name)) {
          const listed = listedInSurfaceDoc(file, text, name);
          expect(listed, `${file}: 命令面声称缺 ${name}（commandDefinitions 是唯一 authority）`).toBe(true);
        }
        for (const name of defaultCommands) {
          expect(listedInSurfaceDoc(file, text, name), `${file}: 公开命令面声称缺 ${name}`).toBe(true);
        }
      }
    });
  }
});
