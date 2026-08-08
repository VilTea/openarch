import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "artifacts", "local");
const pnpmEntry = process.env.npm_execpath;

const run = (args, cwd = root, options = {}) => {
  const command = pnpmEntry ? process.execPath : "pnpm";
  const commandArgs = pnpmEntry ? [pnpmEntry, ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8", ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed with exit code ${result.status}`);
  return result;
};

const tarball = (fragment) => {
  const match = readdirSync(releaseDir).find((name) => name.endsWith(".tgz") && name.includes(fragment));
  if (!match) throw new Error(`local release did not produce a ${fragment} tarball`);
  return join(releaseDir, match);
};

mkdirSync(releaseDir, { recursive: true });
run(["lint"]);
run(["test"]);
for (const packageDir of ["packages/core", "packages/cli", "packages/openarch-plugin"]) {
  run(["--dir", packageDir, "pack", "--pack-destination", relative(packageDir, releaseDir)]);
}

const cli = tarball("openarch-cli-");
const plugin = tarball("openarch-plugin-");
const probe = mkdtempSync(join(tmpdir(), "openarch-local-release-"));
try {
  writeFileSync(join(probe, "package.json"), '{"private":true}\n');
  // CLI bundles its sole internal dependency (@openarch/core), so this install never needs that registry package.
  run(["add", "--ignore-scripts", cli, plugin], probe);
  const help = run(["exec", "openarch", "--help"], probe);
  if (!help.stdout.includes("openarch <command>")) throw new Error("installed openarch did not print its command help");
  const starter = run(["exec", "openarch", "rules", "skeleton", "classification"], probe);
  if (!starter.stdout.includes("pathClasses")) throw new Error("installed openarch did not load packaged script starter assets");
  mkdirSync(join(probe, ".openarch"), { recursive: true });
  writeFileSync(join(probe, ".openarch", "config.yml"), 'languages: ["typescript"]\n');
  writeFileSync(join(probe, "sample.ts"), "export const sample = () => 1;\n");
  const scan = run(["exec", "openarch", "scan", "sample.ts"], probe);
  if (!scan.stdout.includes("scan 完成：1 文件")) throw new Error("installed openarch did not parse the packaged TypeScript grammar");
  for (const [locale, target, marker] of [["zh", "codex", "OpenArch 治理宪法"], ["en", "claude", "OpenArch Governance Constitution"]]) {
    writeFileSync(join(probe, ".openarch", "config.yml"), `presentation:\n  locale: ${locale}\nlanguages: ["typescript"]\n`);
    const install = run(["exec", "openarch", "init", "--agent", target], probe);
    const skill = join(probe, target === "codex" ? ".codex" : ".claude", "skills", "openarch", "SKILL.md");
    if (!install.stdout.includes(`（${locale}）`) || !existsSync(skill) || !readFileSync(skill, "utf8").includes(marker)) {
      throw new Error(`installed openarch did not install the packaged ${locale} project Skill`);
    }
  }
  const userHome = join(probe, "plugin-user-home");
  mkdirSync(userHome, { recursive: true });
  const userInstall = run(["exec", "openarch-agent-install", "--target", "codex", "--locale", "zh"], probe, {
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
  });
  const userSkill = join(userHome, ".codex", "skills", "openarch", "SKILL.md");
  if (!userInstall.stdout.includes("(zh)") || !existsSync(userSkill) || !readFileSync(userSkill, "utf8").includes("OpenArch 治理宪法")) {
    throw new Error("installed plugin did not install the packaged user Skill");
  }
  mkdirSync(join(probe, "src", "main", "java", "demo"), { recursive: true });
  writeFileSync(join(probe, "pom.xml"), "<project />\n");
  writeFileSync(join(probe, ".openarch", "config.yml"), 'languages: ["java"]\n');
  writeFileSync(join(probe, "src", "main", "java", "demo", "Sample.java"), "package demo; public class Sample { public void run() {} }\n");
  const javaScan = run(["exec", "openarch", "scan", "src/main/java/demo/Sample.java"], probe);
  if (!javaScan.stdout.includes("scan 完成：1 文件")) throw new Error("installed openarch did not parse the packaged Java grammar");
  console.log(`本地发行验证通过: ${releaseDir}`);
} finally {
  rmSync(probe, { recursive: true, force: true });
}
