import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("release:local-command 当前仅支持 Windows；请使用对应平台的本地二进制安装方式。");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "artifacts", "binary", `openarch-${process.platform}-${process.arch}`);
const executable = "openarch.exe";
const installDir = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "OpenArch", "bin");

const run = (command, args, { silent = false, ...options } = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (!silent && result.stdout) process.stdout.write(result.stdout);
  if (!silent && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  return result;
};

const normalizePathEntry = (value) => value.replace(/[\\/]+$/, "").toLowerCase();

const readUserPath = () => run(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path', 'User')"],
  { silent: true },
).stdout.trim();

const addInstallDirectoryToUserPath = () => {
  const entries = readUserPath().split(delimiter).filter(Boolean);
  if (entries.some((entry) => normalizePathEntry(entry) === normalizePathEntry(installDir))) return false;
  const updated = [...entries, installDir].join(delimiter);
  run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "[Environment]::SetEnvironmentVariable('Path', $env:OPENARCH_USER_PATH, 'User')"],
    { env: { ...process.env, OPENARCH_USER_PATH: updated } },
  );
  return true;
};

const replaceInstallDirectory = () => {
  if (!existsSync(join(source, executable)) || !existsSync(join(source, "resources"))) {
    throw new Error(`未找到已验证的本地二进制 bundle：${source}。请先运行 pnpm release:binary。`);
  }
  const parent = dirname(installDir);
  const suffix = `${process.pid}-${Date.now()}`;
  const staging = join(parent, `.openarch-staging-${suffix}`);
  const backup = join(parent, `.openarch-backup-${suffix}`);
  mkdirSync(parent, { recursive: true });
  cpSync(source, staging, { recursive: true });
  try {
    if (existsSync(installDir)) renameSync(installDir, backup);
    renameSync(staging, installDir);
  } catch (error) {
    if (existsSync(backup) && !existsSync(installDir)) renameSync(backup, installDir);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  // The new directory is already live. Antivirus/indexers may briefly hold a
  // handle on the retired backup, which must not turn a successful install
  // into a failed release.
  try {
    rmSync(backup, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`⚠ 已安装新本机命令，但暂未能清理旧备份: ${backup} (${error.code ?? "unknown"})`);
  }
};

replaceInstallDirectory();
const pathChanged = addInstallDirectoryToUserPath();
const installedCommand = join(installDir, executable);
const probe = run(installedCommand, ["--help"]);
if (!probe.stdout.includes("openarch <command>")) throw new Error("本机 PATH 命令探针未返回 OpenArch 帮助文本。");

const probeWorkspace = mkdtempSync(join(tmpdir(), "openarch-local-command-"));
try {
  mkdirSync(join(probeWorkspace, ".openarch"), { recursive: true });
  writeFileSync(join(probeWorkspace, ".openarch", "config.yml"), 'languages: ["python"]\n');
  writeFileSync(join(probeWorkspace, "sample.py"), "def sample():\n    return 1\n");
  const scanProbe = run(installedCommand, ["scan", "sample.py"], { cwd: probeWorkspace });
  if (!scanProbe.stdout.includes("scan 完成：1 文件")) throw new Error("本机命令未能从安装目录加载 Python grammar。");
  writeFileSync(join(probeWorkspace, ".openarch", "config.yml"), 'presentation:\n  locale: en\nlanguages: ["python"]\n');
  const installedSkill = join(probeWorkspace, ".codex", "skills", "openarch", "SKILL.md");
  const skillProbe = run(installedCommand, ["init", "--agent", "codex"], { cwd: probeWorkspace });
  if (!skillProbe.stdout.includes("（en）") || !readFileSync(installedSkill, "utf8").includes("OpenArch Governance Constitution")) {
    throw new Error("本机命令未能从安装目录安装英文 Skill。");
  }
} finally {
  rmSync(probeWorkspace, { recursive: true, force: true });
}

console.log(`✓ 本机命令已安装: ${join(installDir, executable)}`);
console.log(pathChanged
  ? "✓ 已加入当前用户 PATH；请重新打开终端或 Agent 会话后直接使用 openarch。"
  : "✓ 当前用户 PATH 已包含安装目录；新终端或 Agent 会话可直接使用 openarch。");
