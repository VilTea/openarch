import { auditConfig } from "@openarch/core";
import { CommandHandler } from "../runtime";
import { message } from "../i18n";

/**
 * 配置审计的**报告面**。
 *
 * D-G16（2026-09-25 项目所有者批准）：`uninitialized` 曾返回 **3**（fail-closed），
 * 而 `init` 从不记录初始哈希 ⇒ 干净项目 `init → scan → check` 得到
 * `Verdict: PASS` 却 **exit 3**（实测复现）。这与 `PASS` 的语义直接冲突
 * ——"没有可比较的哈希"是**事实边界**（无从判断漂移），不是违规；
 * 参照项目自身先例（反模式报告的 `NOT_CONFIGURED` 只声明、不失败）。
 * 现在：`uninitialized` 只提示（exit 0），真正检测到**漂移**仍返回 1。
 */
export const auditCommand: CommandHandler = (args, context) => {
  const result = auditConfig(args.includes("--check") ? "check" : "record");
  console.log(message(context.locale, "audit.heading"));
  console.log(message(context.locale, "audit.status", { status: result.status }));
  if (result.eventPath) {
    console.log(message(context.locale, "audit.event", { path: result.eventPath }));
  }
  if (result.status === "drift") {
    console.log(message(context.locale, "audit.drift"));
    return 1;
  }
  if (result.status === "uninitialized") {
    console.log(message(context.locale, "audit.uninitialized"));
    return 0;
  }
  if (result.status === "missing_config") {
    console.log(message(context.locale, "audit.missingConfig"));
    return 3;
  }
  return 0;
};
