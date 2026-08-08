import { CommandHandler } from "../runtime";
import { antiPatternsCommand } from "./antiPatterns";
import { discoverCommand } from "./discover";
import { extensionsCommand } from "./extensions";
import { message } from "../i18n";

/** Project rule lifecycle: inspect facts/templates, verify contracts, then scan evidence. */
export const rulesCommand: CommandHandler = (args, context) => {
  const [action, ...rest] = args;
  if (action === "check") return extensionsCommand(["--check"], context);
  if (action === "facts") return extensionsCommand(["--facts"], context);
  if (action === "skeleton") return extensionsCommand(["--skeleton", ...rest], context);
  if (action === "scan") return antiPatternsCommand(rest, context);
  if (action === "discover") return discoverCommand(rest, context);
  console.error(message(context.locale, "rules.commandUsage"));
  return 3;
};
