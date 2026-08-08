import { calibrationCommand } from "./calibration";
import { checkCommand } from "./check";
import { contextCommand } from "./context";
import { coordinationCommand } from "./coordination";
import { lspCommand } from "./lsp";
import { antiPatternsCommand } from "./antiPatterns";
import { docsCommand } from "./docs";
import { initCommand } from "./init";
import { reviewCommand } from "./review";
import { rulesCommand } from "./rules";
import { scanCommand } from "./scan";
import { toolchainsCommand } from "./toolchains";
import type { MessageKey } from "../i18n";
import type { CommandHandler } from "../runtime";

export interface CommandDefinition {
  readonly name: string;
  readonly usage: string;
  readonly summaryKey: MessageKey;
  readonly visibility: "default" | "advanced";
  readonly handler: CommandHandler;
  readonly helpKey?: MessageKey;
  readonly actionHelpKeys?: Readonly<Record<string, MessageKey>>;
}

/** The one public command authority: execution, discoverability, and detailed help routing. */
export const commandDefinitions: readonly CommandDefinition[] = [
  { name: "init", usage: "init [options]", summaryKey: "command.init", visibility: "default", handler: initCommand, helpKey: "help.init" },
  { name: "context", usage: "context [--json]", summaryKey: "command.context", visibility: "default", handler: contextCommand, helpKey: "help.context" },
  { name: "scan", usage: "scan [--report] [glob...]", summaryKey: "command.scan", visibility: "default", handler: scanCommand, helpKey: "help.scan" },
  { name: "review", usage: "review [--evolution]", summaryKey: "command.review", visibility: "default", handler: reviewCommand, helpKey: "help.review" },
  { name: "check", usage: "check [--worktree|--staged] [--semantic] [--report] [--verbose] [--tests] [--record-config]", summaryKey: "command.check", visibility: "default", handler: checkCommand, helpKey: "help.check" },
  { name: "rules", usage: "rules <action>", summaryKey: "command.rules", visibility: "default", handler: rulesCommand, helpKey: "help.rules" },
  { name: "docs", usage: "docs <action>", summaryKey: "command.docs", visibility: "default", handler: docsCommand, helpKey: "help.docs", actionHelpKeys: { record: "help.record" } },
  { name: "toolchains", usage: "toolchains [--json]", summaryKey: "command.toolchains", visibility: "default", handler: toolchainsCommand, helpKey: "help.toolchains" },
  { name: "calibration", usage: "calibration export test", summaryKey: "command.calibration", visibility: "advanced", handler: calibrationCommand },
  { name: "coordination", usage: "coordination <action>", summaryKey: "command.coordination", visibility: "advanced", handler: coordinationCommand, helpKey: "help.coordination" },
  { name: "lsp", usage: "lsp <start|stop|status>", summaryKey: "command.lsp", visibility: "advanced", handler: lspCommand },
  { name: "anti-patterns", usage: "anti-patterns [--report]", summaryKey: "command.antiPatterns", visibility: "advanced", handler: antiPatternsCommand },
];

export const commandHandlers: Readonly<Record<string, CommandHandler>> = Object.fromEntries(
  commandDefinitions.map((definition) => [definition.name, definition.handler]),
);

export const knownCommands = Object.keys(commandHandlers).sort();

export const defaultCommandDefinitions = commandDefinitions.filter((definition) => definition.visibility === "default");

export const findCommandDefinition = (command: string | undefined): CommandDefinition | undefined =>
  command ? commandDefinitions.find((definition) => definition.name === command) : undefined;

export const findCommand = (command: string | undefined): CommandHandler | undefined => {
  return command ? commandHandlers[command] : undefined;
};
