import { CommandHandler } from "../runtime";
import { evidenceCommand } from "./evidence";

/** Advanced protocol entry; intentionally omitted from the default command list. */
export const calibrationCommand: CommandHandler = (args, context) => {
  const [action, subject, ...rest] = args;
  if (action === "export" && subject === "test") return evidenceCommand(["test", ...rest], context);
  console.error("用法: openarch calibration export test --project-token <t> --provider-id <id> --rule-id <id> --authority-id <id>");
  return 3;
};
