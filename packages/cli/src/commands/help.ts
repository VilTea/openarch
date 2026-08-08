import { type Locale, message } from "../i18n";
import type { CommandHandler } from "../runtime";
import { defaultCommandDefinitions, findCommandDefinition } from "./index";

export const HELP_ALIASES = new Set(["--help", "-h", "help"]);
const HELP_FLAGS = new Set(["--help", "-h"]);

export const mainHelpText = (locale: Locale): string => {
  return [
    "openarch <command> [--lang zh|en]",
    "",
    message(locale, "help.commands"),
    ...defaultCommandDefinitions.map((definition) => `  ${definition.usage}  ${message(locale, definition.summaryKey)}`),
  ].join("\n");
};

export const helpTextFor = (locale: Locale, command: string | undefined, action?: string): string => {
  const definition = findCommandDefinition(command);
  const key = (action ? definition?.actionHelpKeys?.[action] : undefined) ?? definition?.helpKey;
  return key ? message(locale, key) : mainHelpText(locale);
};

export const helpCommand: CommandHandler = (args, context) => {
  console.log(helpTextFor(context.locale, args[0], args[1]));
  return 0;
};

export const isHelpCommand = (command: string | undefined): boolean => !command || HELP_ALIASES.has(command);

export const hasHelpFlag = (args: readonly string[]): boolean => args.some((arg) => HELP_FLAGS.has(arg));
