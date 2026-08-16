import { auditConfig } from "@openarch/core";
import { CommandHandler } from "../runtime";
import { message } from "../i18n";

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
    return 3;
  }
  if (result.status === "missing_config") {
    console.log(message(context.locale, "audit.missingConfig"));
    return 3;
  }
  return 0;
};
