// packages/core/src/application/initApp.ts
// init 命令的 orchestration——写 config + 恢复 docs-repo + 能力清单检查。
// bin 退化为参数解析 + 调此函数 + 输出。
import { writeInitConfig } from "./initConfig";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { defaultScriptTarget, installDefaultScripts } from "./defaultScripts";
import { readProjectLanguages } from "../projectFiles";
import { resolveDocumentStore } from "../document-store/DocumentStore";
import { renderGovernanceArtifactStager, renderHookLauncher, renderHookPersistenceResolver } from "../hook/HookLauncher";
import { syncGovernancePersistence } from "./governancePersistence";
import { installAgentSkill } from "./agentSkill";
import { configureInitDocuments, documentStoreMessages, ensureProjectDocumentStore } from "./initDocuments";
import { initializeToolchainConfig } from "./toolchainConfigSetup";
import { configureCoordination } from "./coordinationConfig";
import type { InitInput, InitOutput } from "./initTypes";

export type { InitInput, InitOutput } from "./initTypes";

const renderPreCommitHook = (includeProjectDocumentCheck: boolean): string => [
  "#!/bin/bash",
  "# OpenArch pre-commit hook",
  "# Validate staged governance evidence and seal matching semantic evidence.",
  "ROOT=\"$(cd \"$(dirname \"$0\")/../..\" && pwd)\"",
  "export OPENARCH_AGENT_ID=\"${OPENARCH_AGENT_ID:-git-hook}\"",
  "cd \"$ROOT\"",
  renderHookLauncher("enforcing", "OpenArch code governance"),
  renderHookPersistenceResolver(),
  "if [ \"$OPENARCH_PERSISTENCE\" = \"tracked\" ]; then",
  renderGovernanceArtifactStager(),
  "fi",
  "set +e",
  "echo \"-> openarch check evidence (staged)\"",
  "\"$OPENARCH_BIN\" check --staged --report --output-mode summary",
  "DIFF_EXIT=$?",
  "set -e",
  "if [ \"$DIFF_EXIT\" -ge 2 ]; then echo \"missing or invalid semantic evidence\"; exit \"$DIFF_EXIT\"; fi",
  "if [ \"$DIFF_EXIT\" -eq 1 ] && [ \"${OPENARCH_STRICT:-0}\" = \"1\" ]; then echo \"gate WARN + STRICT\"; exit 1; fi",
  ...(includeProjectDocumentCheck ? ["\"$OPENARCH_BIN\" docs check --staged || true"] : []),
  "set +e",
  "\"$OPENARCH_BIN\" check --pre-commit",
  "SEAL_EXIT=$?",
  "set -e",
  "if [ \"$SEAL_EXIT\" -ne 0 ]; then echo \"semantic evidence sealing failed\"; exit \"$SEAL_EXIT\"; fi",
  "if [ \"$OPENARCH_PERSISTENCE\" = \"tracked\" ]; then",
  "  stage_changed_governance_artifacts \"$GOVERNANCE_ARTIFACTS_BEFORE\"",
  "fi",
  "",
].join("\n");

const applyGovernancePersistence = async (input: InitInput, messages: string[]): Promise<InitOutput | undefined> => {
  if (!input.persistence) return undefined;
  try {
    const migration = await syncGovernancePersistence(input.cwd, input.persistence);
    messages.push("✓ 治理持久化模式: " + migration.persistence);
    messages.push(migration.configChanged ? "  config.yml 已更新" : "  config.yml 已处于目标模式");
    if (migration.exclude === "updated") messages.push("  本地 Git exclude 已更新（仅 OpenArch 标记区块）");
    if (migration.exclude === "unavailable") messages.push("  ⚠ 未发现 Git 仓库，无法同步本地 exclude");
    if (migration.trackedPaths.length > 0) {
      messages.push("  ⚠ " + migration.trackedPaths.length + " 个 .openarch 路径已被 Git 跟踪，未自动取消追踪。");
      messages.push("    如确认迁移为个人模式，审阅后执行: git rm --cached -- .openarch");
    }
    return undefined;
  } catch (error) {
    return { code: 3, messages: ["✗ 治理持久化迁移失败: " + (error instanceof Error ? error.message : String(error))] };
  }
};

const installOrUpdateHook = (input: InitInput, messages: string[]): boolean => {
  const hookPath = input.cwd + "/.git/hooks/pre-commit";
  const existingOpenArchHook = existsSync(hookPath) && readFileSync(hookPath, "utf8").includes("# OpenArch pre-commit hook");
  const shouldInstall = input.installHook || Boolean(input.persistence && existingOpenArchHook);
  if (!shouldInstall) return existingOpenArchHook;
  if (existsSync(hookPath) && !existingOpenArchHook) {
    messages.push("  (pre-commit hook 已存在，跳过)");
    return false;
  }
  mkdirSync(dirname(hookPath), { recursive: true });
  const store = resolveDocumentStore(input.cwd);
  writeFileSync(hookPath, renderPreCommitHook(store?.mode !== "shared"), { mode: 0o755 });
  messages.push(existingOpenArchHook ? "✓ pre-commit hook 已更新" : "✓ pre-commit hook 已安装");
  return true;
};

const configureToolchains = async (input: InitInput, messages: string[]): Promise<InitOutput | undefined> => {
  if (!input.toolchainConfigScope) return undefined;
  const toolchains = await initializeToolchainConfig({ cwd: input.cwd, scope: input.toolchainConfigScope });
  if ("error" in toolchains) return { code: 3, messages: [...messages, `✗ Toolchain 配置初始化失败: ${toolchains.error}`] };
  messages.push(`✓ Toolchain ${input.toolchainConfigScope === "user" ? "用户级" : "项目本机"}配置${toolchains.created ? "已创建" : "已存在，保持不动"}: ${toolchains.path}`);
  if (toolchains.exclude === "updated") messages.push("  项目本机 toolchains 配置已加入 Git info/exclude");
  if (toolchains.exclude === "unavailable") messages.push("  ⚠ 未发现 Git 仓库；请勿提交项目本机 toolchains 配置");
  return undefined;
};

const configureCoordinator = (input: InitInput, messages: string[]): InitOutput | undefined => {
  if (!input.coordinationUrl && !input.clearCoordination) return undefined;
  const result = configureCoordination({ cwd: input.cwd, url: input.coordinationUrl, clear: input.clearCoordination });
  if ("error" in result) return { code: 3, messages: [...messages, `✗ 协调服务配置失败: ${result.error}`] };
  if (result.action === "configured" || result.action === "unchanged") {
    messages.push(`✓ 协调服务地址${result.action === "configured" ? "已配置" : "未变"}: ${result.url}`);
    messages.push("  该本机设置不含凭据，也不等同于协作文档仓库关联。");
  } else {
    messages.push(result.action === "cleared" ? "✓ 协调服务地址已清除" : "  ℹ 未配置协调服务地址");
  }
  return undefined;
};

export const initApp = async (input: InitInput): Promise<InitOutput> => {
  const msgs: string[] = [];
  const documentResult = configureInitDocuments(input);
  // A failing document result aborts init; a successful one (docs-repo
  // association) continues so later options like --coordination-url apply.
  if (documentResult && documentResult.code !== 0) return documentResult;
  if (documentResult) msgs.push(...documentResult.messages);
  const { Effect } = await import("effect");
  const configResult = await Effect.runPromise(writeInitConfig(input.cwd).pipe(Effect.either));
  if (configResult._tag === "Left") return { code: 3, messages: ["init 失败（exit 3）"] };
  const config = configResult.right;
  msgs.push(`✓ OpenArch 初始化完成：${config.configPath}`);
  msgs.push(config.configExisted ? "  (config.yml 已存在，保持不动)" : "  (config.yml 已创建)");

  const persistenceFailure = await applyGovernancePersistence(input, msgs);
  if (persistenceFailure) return persistenceFailure;
  const hookInstalled = installOrUpdateHook(input, msgs);
  if (input.persistence && !hookInstalled) {
    msgs.push("  未安装 OpenArch hook；如需提交时验证，请额外运行: openarch init --install-hook");
  }

  if (input.agentSkillTarget || input.skillDir) {
    const skill = installAgentSkill({ cwd: input.cwd, target: input.agentSkillTarget, skillDir: input.skillDir });
    if ("error" in skill) return { code: 3, messages: [...msgs, `✗ Skill 安装失败: ${skill.error}`] };
    msgs.push(`✓ OpenArch Skill 已${skill.action === "installed" ? "安装" : "更新"}（${skill.locale}）: ${skill.destination}`);
  }

  const toolchainFailure = await configureToolchains(input, msgs);
  if (toolchainFailure) return toolchainFailure;

  const coordinatorFailure = configureCoordinator(input, msgs);
  if (coordinatorFailure) return coordinatorFailure;

  msgs.push("  项目事实入口: openarch context --json；再结合当前任务选择 scan、review、check、rules 或 docs。");
  ensureProjectDocumentStore(input);
  if (readProjectLanguages(input.cwd).length === 0) {
    msgs.push("  ⚠ 未检测到当前已支持的语言；生产代码扫描与 gate 将保持 UNAVAILABLE，直到配置受支持语言。");
  }
  if (input.defaultScripts?.length) {
    const languages = readProjectLanguages(input.cwd);
    const scripts = installDefaultScripts(input.cwd, languages, input.defaultScripts, { replace: input.replaceDefaultScripts });
    for (const id of scripts.installed) {
      msgs.push(`  ✓ 默认脚本已安装: ${id}`);
      msgs.push(`    路径: ${defaultScriptTarget(id)}`);
    }
    for (const id of scripts.replaced) {
      msgs.push(`  ✓ 默认脚本已替换: ${id}`);
      msgs.push(`    路径: ${defaultScriptTarget(id)}`);
    }
    for (const id of scripts.unchanged) msgs.push(`  ℹ 默认脚本已存在，保持不动: ${id}`);
    for (const error of scripts.errors) msgs.push(`  ⚠ ${error}`);
    if (scripts.installed.length > 0 || scripts.replaced.length > 0) {
      msgs.push("  验证已安装脚本: openarch rules check");
      msgs.push("  校准/回扫: openarch rules scan");
    }
  }

  msgs.push(...documentStoreMessages(input.cwd));

  return { code: 0, messages: msgs };
};
