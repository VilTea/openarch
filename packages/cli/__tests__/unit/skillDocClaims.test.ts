import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commandDefinitions } from "../../src/commands";
import { message } from "../../src/i18n";

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

/**
 * 退出码语义的**完整性**守卫（2026-09-27 复验发现的三处陈述）。
 *
 * 事实依据：`0/1/2/3` 的映射现在同时出现在 `check --help`（用户面，i18n）、
 * `exit-code.ts` 的注释（实现面）与发行版 `gate-response.md`（agent 面，8 份镜像）。
 * 三处**当前无矛盾**，但同一事实三处维护 ⇒ 只要有一处漏掉某个码或某种状态，
 * 读它的一方就会得出不同的结论。
 *
 * **这条守卫只证明"完整性"，不证明"措辞等价"**（后者需要解析自然语言，做不到就不假装做到）：
 * 它断言两个面都列出了全部四个码与四种状态词。若要进一步收敛，应让 skill 直接引用
 * `openarch check --help`（属产品决策，未擅自改）。
 */
const EXIT_CODE_STATES = ["PASS", "WARN", "BLOCK", "UNAVAILABLE"] as const;
const EXIT_CODE_MIRRORS = [
  ".agents/skills/openarch/gate-response.md",
  ".agents/skills/openarch-locales/en/gate-response.md",
  "packages/core/assets/agent-skills/openarch/locales/zh/gate-response.md",
  "packages/core/assets/agent-skills/openarch/locales/en/gate-response.md",
  "packages/openarch-plugin/assets/agent-skills/openarch/locales/zh/gate-response.md",
  "packages/openarch-plugin/assets/agent-skills/openarch/locales/en/gate-response.md",
  "packages/openarch-plugin/skills/openarch-zh/gate-response.md",
  "packages/openarch-plugin/skills/openarch-en/gate-response.md",
];

describe("退出码语义在两个面上都完整", () => {
  it("check --help（zh/en）列出全部四个退出码与四种状态", () => {
    for (const locale of ["zh", "en"] as const) {
      const help = message(locale, "help.check");
      for (const code of ["0", "1", "2", "3"]) {
        expect(help, `${locale}: check --help 未逐行列退出码 ${code}`).toMatch(new RegExp(`^\\s*${code}\\s`, "m"));
      }
      for (const state of EXIT_CODE_STATES) {
        expect(help, `${locale}: check --help 未提到 ${state}`).toContain(state);
      }
    }
  });

  it("发行版 gate-response.md 的每份镜像都列出同样四个码与四种状态", () => {
    for (const relative of EXIT_CODE_MIRRORS) {
      const file = resolve(repositoryRoot, relative);
      // release 分支无 .agents 源树（与上面的 skipIf 同一口径）。
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      expect(text, `${relative}: 缺「退出码」小节`).toMatch(/^## (退出码|Exit codes)/m);
      for (const code of ["0", "1", "2", "3"]) {
        expect(text, `${relative}: 未列出退出码 ${code}`).toContain(`\`${code}\``);
      }
      for (const state of EXIT_CODE_STATES) {
        expect(text, `${relative}: 未提到 ${state}`).toContain(state);
      }
    }
  });
});
