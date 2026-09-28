import { AGENT_SKILL_TARGETS, auditConfig, initApp } from "@openarch/core";
import { message } from "../i18n";
import { CommandHandler, parseOptionValue } from "../runtime";

export const initCommand: CommandHandler = async (args, context) => {
  const mode = parseOptionValue(args, "--mode");
  if (mode !== undefined && mode !== "personal" && mode !== "team") {
    console.error(message(context.locale, "init.invalidMode"));
    return 3;
  }
  const agent = parseOptionValue(args, "--agent");
  const skillDir = parseOptionValue(args, "--skill-dir");
  const toolchainConfigScope = parseOptionValue(args, "--toolchains");
  const coordinationUrl = parseOptionValue(args, "--coordination-url");
  if (args.includes("--agent") && agent === undefined) {
    console.error(message(context.locale, "init.agentRequired"));
    return 3;
  }
  if (agent !== undefined && !AGENT_SKILL_TARGETS.includes(agent as typeof AGENT_SKILL_TARGETS[number])) {
    console.error(message(context.locale, "init.invalidAgent", { agents: AGENT_SKILL_TARGETS.join(context.locale === "zh" ? "、" : ", ") }));
    return 3;
  }
  if (args.includes("--skill-dir") && skillDir === undefined) {
    console.error(message(context.locale, "init.skillDirRequired"));
    return 3;
  }
  if (agent !== undefined && skillDir !== undefined) {
    console.error(message(context.locale, "init.agentSkillDirConflict"));
    return 3;
  }
  if (toolchainConfigScope !== undefined && toolchainConfigScope !== "user" && toolchainConfigScope !== "project") {
    console.error(message(context.locale, "init.invalidToolchainScope"));
    return 3;
  }
  if (args.includes("--coordination-url") && coordinationUrl === undefined) {
    console.error(message(context.locale, "init.coordinationUrlRequired"));
    return 3;
  }
  if (coordinationUrl !== undefined && args.includes("--clear-coordination")) {
    console.error(message(context.locale, "init.coordinationConflict"));
    return 3;
  }
  const installScripts = parseOptionValue(args, "--install-script")
    ?.split(",")
    .map((script) => script.trim())
    .filter(Boolean);
  const replaceScripts = parseOptionValue(args, "--replace-script")
    ?.split(",")
    .map((script) => script.trim())
    .filter(Boolean);
  if (installScripts && replaceScripts) {
    console.error(message(context.locale, "init.scriptConflict"));
    return 3;
  }

  const result = await initApp({
    cwd: context.cwd,
    docsRepo: parseOptionValue(args, "--docs-repo"),
    documentStore: parseOptionValue(args, "--docs-store") === "project" ? "project" : undefined,
    documentScope: parseOptionValue(args, "--docs-scope"),
    unlink: args.includes("--unlink"),
    installHook: args.includes("--install-hook"),
    agentSkillTarget: agent as typeof AGENT_SKILL_TARGETS[number] | undefined,
    skillDir,
    persistence: mode === "personal" ? "local" : mode === "team" ? "tracked" : undefined,
    defaultScripts: replaceScripts ?? installScripts,
    replaceDefaultScripts: replaceScripts !== undefined,
    toolchainConfigScope: toolchainConfigScope as "user" | "project" | undefined,
    coordinationUrl,
    clearCoordination: args.includes("--clear-coordination"),
  });

  for (const message of result.messages) {
    console.log(message);
  }

  // D-G16：初始化成功后记录一次**配置哈希**，使新项目不会在第一次 `check` 时因
  // "配置审计未初始化"而失败（实测：`init → scan → check` 曾得到 PASS + exit 3）。
  // 只写审计事件、不打印——审计的报告面归 `check`。写入失败不影响初始化结果
  // （审计是观察面，缺它只是少一个漂移信号，`check` 会如实提示未初始化）。
  if (result.code === 0 && !args.includes("--unlink")) {
    try {
      auditConfig("record");
    } catch {
      // 观察面失败不阻断初始化；后续 `check` 会报告 uninitialized 并给出记录方式。
    }
  }

  return result.code;
};
