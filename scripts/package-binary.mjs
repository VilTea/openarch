import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = `${process.platform}-${process.arch}`;
const releaseDir = join(root, "artifacts", "binary", `openarch-${target}`);
const executable = join(releaseDir, process.platform === "win32" ? "openarch.exe" : "openarch");
const version = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8")).version;
const requireCore = createRequire(join(root, "packages", "core", "package.json"));

const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  return result;
};

const probe = (command, args, cwd) => run(command, args, cwd).stdout;

const languageProbes = [
  { language: "typescript", path: "sample.ts", source: "export const sample = () => 1;\n" },
  { language: "go", path: "sample.go", source: "package sample\nfunc Run() {}\n" },
  { language: "rust", path: "sample.rs", source: "pub fn run() {}\n" },
  { language: "python", path: "sample.py", source: "def run():\n    return 1\n" },
  { language: "java", path: "src/main/java/demo/Sample.java", source: "package demo; public class Sample { public void run() {} }\n" },
];

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
run("bun", ["build", "--compile", "--define", `__OPENARCH_VERSION__=${JSON.stringify(version)}`, "packages/cli/src/main.ts", "--outfile", executable]);
cpSync(join(root, "packages", "core", "assets"), join(releaseDir, "resources", "assets"), { recursive: true });
cpSync(join(root, "packages", "core", "grammars"), join(releaseDir, "resources", "grammars"), { recursive: true });
mkdirSync(join(releaseDir, "resources", "tree-sitter"), { recursive: true });
cpSync(requireCore.resolve("web-tree-sitter/web-tree-sitter.wasm"), join(releaseDir, "resources", "tree-sitter", "web-tree-sitter.wasm"));

const installationRoot = mkdtempSync(join(tmpdir(), "openarch-binary-install-"));
const installedDir = join(installationRoot, "bin");
const installedExecutable = join(installedDir, process.platform === "win32" ? "openarch.exe" : "openarch");
const workspace = mkdtempSync(join(tmpdir(), "openarch-binary-release-"));
try {
  // Exercise the copied installation, not the build directory or source tree.
  cpSync(releaseDir, installedDir, { recursive: true });
  mkdirSync(join(workspace, ".openarch"), { recursive: true });
  if (!probe(installedExecutable, ["--help"], workspace).includes("openarch <command>")) throw new Error("binary did not print command help");
  if (!probe(installedExecutable, ["rules", "skeleton", "classification"], workspace).includes("pathClasses")) throw new Error("binary did not load packaged script assets");
  for (const sample of languageProbes) {
    const path = join(workspace, sample.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(join(workspace, ".openarch", "config.yml"), `languages: ["${sample.language}"]\n`);
    writeFileSync(path, sample.source);
    if (!probe(installedExecutable, ["scan", sample.path], workspace).includes("scan 完成：1 文件")) throw new Error(`binary did not load the packaged ${sample.language} grammar`);
  }
  for (const [locale, target, marker] of [["zh", "codex", "OpenArch 治理宪法"], ["en", "claude", "OpenArch Governance Constitution"]]) {
    writeFileSync(join(workspace, ".openarch", "config.yml"), `presentation:\n  locale: ${locale}\nlanguages: ["python"]\n`);
    const installedSkill = join(workspace, target === "codex" ? ".codex" : ".claude", "skills", "openarch", "SKILL.md");
    if (!probe(installedExecutable, ["init", "--agent", target], workspace).includes(`（${locale}）`) || !readFileSync(installedSkill, "utf8").includes(marker)) {
      throw new Error(`binary did not install the packaged ${locale} project Skill`);
    }
  }
  console.log(`本地二进制发行验证通过: ${releaseDir}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(installationRoot, { recursive: true, force: true });
}
