// packages/core/src/application/initConfig.ts
import { Effect } from "effect";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { IoError } from "../errors/errors";
import { detectProjectLanguages } from "../languageSupport";

export interface InitConfigResult {
  readonly configPath: string;
  readonly excludePath: string;
  readonly configExisted: boolean;
  readonly excludeUpdated: boolean;
}

const RUNTIME_IGNORE_ENTRIES = ["pending/", "scan-status.json", ".*.lock", "coordination.json"] as const;
const RUNTIME_IGNORE_HEADER = "# OpenArch runtime artifacts";

/**
 * Runtime observations are replaceable local state even for tracked governance.
 * A nested OpenArch project may live inside a larger Git worktree, so its parent
 * repository's root .gitignore cannot be relied on to exclude these paths.
 */
const ensureRuntimeArtifactsIgnored = (cwd: string): boolean => {
  const ignorePath = join(cwd, ".openarch", ".gitignore");
  const before = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const existing = new Set(before.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = RUNTIME_IGNORE_ENTRIES.filter((entry) => !existing.has(entry));
  if (missing.length === 0) return false;
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const prefix = before.length > 0 && !before.endsWith("\n") ? before + newline : before;
  const header = existing.has(RUNTIME_IGNORE_HEADER) ? "" : RUNTIME_IGNORE_HEADER + newline;
  writeFileSync(ignorePath, prefix + header + missing.join(newline) + newline, "utf8");
  return true;
};

const defaultPresentationLocale = (): "zh" | "en" =>
  Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en";

const defaultStructuralPolicies = (languages: readonly string[]): string => languages.map((language) => [
    `  - id: "${language}-observe"`,
    `    languages: ["${language}"]`,
    "    mode: observe",
    "    rules_block: []",
    "    rules_warn: []",
  ].join("\n")).join("\n");

const structuralPolicySection = (languages: readonly string[]): string => languages.length === 0
  ? "structural_policies: []"
  : `structural_policies:\n${defaultStructuralPolicies(languages)}`;

const buildDefaultConfigYml = (languages: readonly string[]) => `# OpenArch 配置文件（design v5.2 §8.1）
version: "5.2"

# 人类与 Agent 的默认 CLI 展示语言；可由 --lang 或 OPENARCH_LANG 临时覆盖。
presentation:
  locale: "${defaultPresentationLocale()}"

governance:
  # tracked: 决策产物（config.yml/规则/校准样本）自动暂存随提交复核，运行产物
  #   （baseline/history/audit）不自动提交，可由 openarch scan 幂等重建；
  # local: 仅本机治理状态，.openarch 整体不进 git。
  persistence: tracked
  # 保留近期原始 sealed history；更早记录压缩为数学等价的 CRL checkpoint。
  history:
    raw_window_days: 180

# 项目语言（决定 openarch scan 匹配的文件扩展名）；空数组表示尚无已支持语言，
# OpenArch 将诚实报告 unavailable，而不会把未知项目伪装成 TypeScript。
languages: [${languages.map((language) => `"${language}"`).join(", ")}]

paths:
  default:
    pattern: "**"

# 每个语言总体独立观察；未校准前不继承另一语言的阈值或 P95。
# 规则可使用 max_func_branch（单函数）与 top_level_branch（顶层分派）；阈值须由该总体校准。
${structuralPolicySection(languages)}

# 测试治理由项目策略裁决；provider/script 只产生标准 finding。
test_governance:
  providers: []
  runners: []
  rules: {}
  exemptions: []
`;

const detectDefaultLanguages = (cwd: string): readonly string[] => detectProjectLanguages(cwd);

/** init 一步：写 .openarch/config.yml。幂等（已存在不覆盖）。 */
export const writeInitConfig = (cwd: string): Effect.Effect<InitConfigResult, IoError> =>
  Effect.gen(function* () {
    return yield* Effect.try({
      try: () => {
        const configPath = join(cwd, ".openarch", "config.yml");
        mkdirSync(dirname(configPath), { recursive: true });
        const configExisted = existsSync(configPath);
        let configRecovered = false;
        if (!configExisted) {
          // 尝试从 git 恢复（rm -rf .openarch 后 git checkout 已有版本）
          try {
            execFileSync("git", ["checkout", "--", ".openarch/config.yml"], { cwd, stdio: "pipe", timeout: 5000 });
            configRecovered = existsSync(configPath);
          } catch { /* not in git */ }
          if (!existsSync(configPath)) writeFileSync(configPath, buildDefaultConfigYml(detectDefaultLanguages(cwd)));
        }
        const excludeUpdated = ensureRuntimeArtifactsIgnored(cwd);
        return { configPath, excludePath: join(cwd, ".openarch", ".gitignore"), configExisted: configExisted || configRecovered, excludeUpdated };
      },
      catch: (e) => new IoError({ path: cwd, cause: e }),
    });
  });
