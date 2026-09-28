#!/usr/bin/env node
/**
 * release 分支策展构建器（2026-09-27 所有者批准，方案 A）。
 *
 * 背景：`release` 与 `main` **没有共同祖先** —— `release` 是"每版本一个
 * `release: OpenArch X.Y.Z` 提交"的策展快照线（也是唯一推送到远端的线）。因此"更新 release"
 * 不是 merge，而是把 `main` 的**策展子集**写到 release 树上，再应用几处 release 专属编辑。
 *
 * 为什么需要脚本（而不是继续手工策展）：2026-09-27 的树级比对在手工线上抓到三类漏项 ——
 * `docs/README.md` 里指向 `internal/design.md`、`internal/archive/` 的悬空链接（release 根本没有
 * `docs/internal/`）、发行 Skill 引用的 `docs/language-parser-extension.md` 不在 release、
 * 以及两个已被收敛掉的 per-host `INSTALL.md`。手工清单没有守卫，脚本有。
 *
 * 用法（在 main 检出里跑；脚本**不**提交、**不**推送、**不**打 tag）：
 *   node scripts/release-branch.mjs --plan                     # 只报告将发生的差异（默认）
 *   node scripts/release-branch.mjs --build 0.2.0 [--date YYYY-MM-DD]
 *                                                              # 在独立 worktree 里构建策展树
 *   node scripts/release-branch.mjs --check                    # 只跑引用完整性检查（需已 --build）
 *
 * 退出码：0 = 无阻断；1 = 完整性检查发现阻断项；2 = 用法错误。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, ".release-build");

/** 不随 release 发布的路径（dev-only）。每一项都要有理由，不允许"顺手排除"。 */
const EXCLUDED = [
  { prefix: ".agents/", why: "codex 开发面 Skill 源树；发行资产在 packages/*/assets 与 plugin/skills" },
  { prefix: ".claude/", why: "本地 agent 配置（.gitignore 同款）" },
  { prefix: ".obsidian/", why: "本地笔记配置" },
  { prefix: "docs/internal/", why: "内部调研/校准/经验记录，含未整理笔记" },
  { prefix: "docs/design.md", why: "设计 living spec（v5.3）：按**惯例**不随发布分支（2026-09-27 所有者确认）" },
  { prefix: "AGENTS.md", why: "开发仓 agent 指令（面向本仓开发者）" },
  { prefix: "CLAUDE.md", why: "同上" },
];
const EXCLUDED_EXACT = new Set(["AGENTS.md", "CLAUDE.md"]);

/**
 * 统一走 `-c core.quotepath=false`：git 默认会把非 ASCII 路径转义成 `"docs/internal/\344…"`，
 * 那样前缀匹配会**漏掉中文名的内部文档**（实测：23 个 `docs/internal/**` 会被当成"应随行"）。
 * 本项目内部文档大量使用中文文件名，这行不是锦上添花而是正确性前提。
 */
const git = (args, options = {}) => execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd: root, encoding: "utf8", ...options }).trim();

const isExcluded = (path) =>
  EXCLUDED_EXACT.has(path) || EXCLUDED.some((entry) => path.startsWith(entry.prefix));

const treeOf = (ref) => {
  const out = git(["ls-tree", "-r", "--name-only", ref]);
  return out === "" ? [] : out.split("\n");
};

/** 版本号只出现在这四份 manifest 里（`release-notes.mjs` 与 CLI 都从 manifest 读）。 */
const VERSION_FILES = ["package.json", "packages/cli/package.json", "packages/core/package.json", "packages/openarch-plugin/package.json"];

const plan = () => {
  const main = treeOf("HEAD");
  const release = treeOf("release");
  const releaseSet = new Set(release);
  const mainSet = new Set(main);

  const add = main.filter((path) => !releaseSet.has(path) && !isExcluded(path));
  const keep = main.filter((path) => releaseSet.has(path) && !isExcluded(path));
  const drop = release.filter((path) => !mainSet.has(path));
  const excluded = main.filter((path) => !releaseSet.has(path) && isExcluded(path));
  const excludedButPresent = release.filter((path) => isExcluded(path));

  console.log("== 策展计划（main → release）==");
  console.log(`  随行(新增)      : ${add.length}`);
  console.log(`  随行(已存在,内容可能更新): ${keep.length}`);
  console.log(`  删除(release 独有): ${drop.length}`);
  console.log(`  排除(dev-only)  : ${excluded.length}`);
  console.log(`  违规: release 里存在被排除路径: ${excludedButPresent.length}${excludedButPresent.length ? ` → ${excludedButPresent.slice(0, 5).join(", ")}` : ""}`);
  console.log("\n  排除规则（每条都要有理由）:");
  for (const entry of EXCLUDED) console.log(`    ${entry.prefix.padEnd(18)} ${entry.why}`);
  console.log("\n  新增项按目录:");
  for (const [name, count] of groupBy(add)) console.log(`    ${String(count).padStart(4)}  ${name}`);
  console.log("\n  删除项（应只有已收敛的 per-host 文档）:");
  for (const path of drop) console.log(`    ${path}`);
  return excludedButPresent.length === 0 ? 0 : 1;
};

const groupBy = (paths, depth = 2) => {
  const counts = new Map();
  for (const path of paths) {
    const parts = path.split("/");
    const key = parts.slice(0, Math.min(depth, parts.length)).join("/");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

/** release 专属编辑：只在 release 树上做（main 上这些内容是正确的）。 */
const applyReleaseEdits = (version, date) => {
  // ① 版本号（定点字符串替换，避免 JSON 重新序列化改动文件格式）
  for (const file of VERSION_FILES) {
    const path = join(buildDir, file);
    const before = readFileSync(path, "utf8");
    const after = before.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);
    if (before === after) throw new Error(`${file}: 未找到可替换的 version 字段`);
    writeFileSync(path, after);
  }

  // ② CHANGELOG：把 [Unreleased] 段落切成 [<version>] - <date>，顶部留一个占位 Unreleased
  const changelogPath = join(buildDir, "CHANGELOG.md");
  const lines = readFileSync(changelogPath, "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => /^## \[Unreleased\]/.test(line));
  if (start < 0) throw new Error("CHANGELOG.md: 未找到 ## [Unreleased]");
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  if (end < 0) throw new Error("CHANGELOG.md: [Unreleased] 之后没有版本段落");
  const body = lines.slice(start + 1, end).filter((line) => line.trim() !== "" && line.trim() !== "（待补充）");
  const cut = [
    ...lines.slice(0, start),
    "## [Unreleased]", "", "（待补充）", "",
    `## [${version}] - ${date}`, "",
    ...body,
    "",
    ...lines.slice(end),
  ];
  writeFileSync(changelogPath, cut.join("\n"));

  // ③ docs/README.md 是随行的索引，但索引里包含不随行的行（`docs/internal/**` 与按惯例排除的
  // `docs/design.md`）：统一把这些链接降级为纯文本，避免发布物里出现悬空链接。
  // 用**通用规则**而不是逐行硬编码 —— 早先的逐条替换正是漏掉 3 条的原因。
  const docsReadmePath = join(buildDir, "docs/README.md");
  const docs = readFileSync(docsReadmePath, "utf8")
    .replace(/\[([^\]]+)\]\(\.\/(?:internal\/|design\.md)[^)]*\)/g, "$1");
  writeFileSync(docsReadmePath, docs);
};

/**
 * 检查范围的**豁免**（每条也都要有理由，否则守卫就会变成"喊狼来了"）：
 * 第一版硬阻断 17 项里绝大多数是自指或预期内容 —— 实测：清单定义处、发布说明、带守卫的测试。
 */
const CHECK_EXEMPT = [
  { match: (path) => path === "scripts/release-branch.mjs", why: "它自己就是排除清单的定义处，必然出现这些前缀" },
  { match: (path) => path === "CHANGELOG.md", why: "发布说明描述开发线改动，散文提及 dev 路径属预期（不是可跟随的链接）" },
  { match: (path) => path.includes("__tests__/"), why: "测试用例用 existsSync 守卫、在 release 上自动跳过；由 release 树上的测试运行单独验证" },
];

/**
 * 引用完整性检查：release 树里**随行文件**不得引用被排除的路径，且 docs 索引的相对链接必须可解析。
 * 这是脚本存在的核心理由（手工策展在这三处都漏了）。
 *
 * 分两档，因为"提到"与"引用"不是一回事：
 * - **hard**（exit 1）：`docs/internal/`、`.agents/`、`.obsidian/`、`.claude/`（安装目标
 *   `.claude/skills/...` 除外 —— 那是文档要告诉用户的**落点**，不是本仓文件引用）；
 * - **soft**（只提示）：`AGENTS.md`/`CLAUDE.md` 的**提及**（它们不随行，但散文里提到文件名
 *   不像链接那样会悬空）。第一版把这两档混在一起，结果 19 项里 11 项是误报 —— 会喊狼来了的
 *   守卫比没有守卫更糟。
 */
const check = () => {
  const hard = [];
  const soft = [];
  const HARD = [
    { re: /(?:^|[\s(`"'\[])(?:docs\/internal\/|\.agents\/|\.obsidian\/)/, why: "引用随行排除的内部目录" },
    { re: /docs\/design\.md/, why: "引用按惯例不随行的设计 living spec" },
    { re: /(?:^|[\s(`"'\[])\.claude\/(?!skills)/, why: "引用本地 agent 配置目录（`.claude/skills` 作为安装目标除外）" },
  ];
  const SOFT = [{ re: /(?:^|[\s(`"'\[])(?:AGENTS\.md|CLAUDE\.md)/, why: "提到开发仓指令文件（不随行）" }];
  for (const path of treeOf("HEAD")) {
    if (isExcluded(path)) continue;
    if (CHECK_EXEMPT.some((entry) => entry.match(path))) continue;
    const candidate = join(buildDir, path);
    if (!existsSync(candidate)) continue;
    if (!/\.(?:ts|mjs|js|json|md|html|yml)$/.test(path)) continue;
    const text = readFileSync(candidate, "utf8");
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      for (const rule of HARD) if (rule.re.test(line)) hard.push(`${path}:${index + 1} ${rule.why} → ${line.trim().slice(0, 110)}`);
      for (const rule of SOFT) if (rule.re.test(line)) soft.push(`${path}:${index + 1} ${rule.why} → ${line.trim().slice(0, 110)}`);
    }
  }
  // docs 索引链接可解析性
  const docsReadme = join(buildDir, "docs/README.md");
  if (existsSync(docsReadme)) {
    for (const match of readFileSync(docsReadme, "utf8").matchAll(/\]\(\.\/([\w./-]+)\)/g)) {
      if (!existsSync(join(buildDir, "docs", match[1]))) hard.push(`docs/README.md 链接悬空: ./${match[1]}`);
    }
  }
  for (const note of soft) console.warn(`  [提示] ${note}`);
  if (hard.length === 0) {
    console.log(`✓ 引用完整性检查通过（hard 0 项${soft.length ? `，提示 ${soft.length} 项` : ""}）`);
    return 0;
  }
  console.error(`✗ 引用完整性检查发现 ${hard.length} 项阻断：`);
  for (const problem of hard) console.error(`  ${problem}`);
  return 1;
};

const build = (version, date, refresh = false) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本号格式应为 X.Y.Z：${version}`);
  if (existsSync(buildDir) && !refresh) throw new Error(`${buildDir} 已存在；用 --refresh 就地重建，或先 git worktree remove`);
  if (refresh && existsSync(buildDir)) {
    // 就地重建：保留 node_modules（省掉一次 2m+ 的安装），只把树退回到 release tip 再重新策展。
    git(["reset", "--hard", "release"], { cwd: buildDir });
    git(["clean", "-fd", "-e", "node_modules"], { cwd: buildDir });
  } else {
    // 注意：worktree **挂到 release 分支上**（不是 --detach），否则在那里提交不会推进 release。
    git(["worktree", "add", buildDir, "release"]);
  }
  const mainSha = git(["rev-parse", "HEAD"]); // main 的提交号：在 build worktree 里 `HEAD` 指的是 release
  const mainTree = treeOf("HEAD");
  const mainSet = new Set(mainTree);
  const main = mainTree.filter((path) => !isExcluded(path));
  // 用 `git restore --pathspec-from-file=-`（NUL 分隔、走 stdin）而不是把路径当参数：
  // 811 个路径直接进命令行会撞上 Windows 的 `spawnSync git ENAMETOOLONG`（实测）。
  if (main.length > 0) {
    git(["restore", `--source=${mainSha}`, "--staged", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      cwd: buildDir,
      input: main.map((path) => `${path}\0`).join(""),
      maxBuffer: 1 << 28,
    });
  }
  // 删除 release 独有文件（per-host INSTALL 等），以及任何"本不该随行"的排除路径
  const doomed = treeOf("release").filter((path) => !mainSet.has(path) || isExcluded(path));
  for (const path of doomed) git(["rm", "-q", "-f", "--ignore-unmatch", path], { cwd: buildDir });
  applyReleaseEdits(version, date);
  console.log(`✓ 已在 ${buildDir} 构建 release ${version}（release worktree，未提交）`);
  console.log("  下一步（在 .release-build 里跑，然后提交到 release 分支）：");
  console.log("    cd .release-build && pnpm install --frozen-lockfile && pnpm lint && pnpm test");
  console.log(`    git -C .release-build add -A && git -C .release-build commit -m "release: OpenArch ${version}"`);
  console.log(`    git -C .release-build tag v${version}   # 然后 git push origin release + git push origin v${version}`);
  return 0;
};

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
try {
  if (args.includes("--check")) process.exit(check());
  if (args.includes("--build")) {
    const version = option("--build");
    if (!version) throw new Error("--build 需要版本号，例如 --build 0.2.0");
    process.exit(build(version, option("--date") ?? new Date().toISOString().slice(0, 10), args.includes("--refresh")));
  }
  process.exit(plan());
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
