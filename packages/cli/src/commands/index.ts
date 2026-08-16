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

/** 命令模块只在真正执行时动态加载；注册表本身不再把 14 个命令的实现图拉进 `--help`/未知命令路径。 */
const lazyHandler = (load: () => Promise<CommandHandler>): CommandHandler => (args, context) =>
  Promise.resolve().then(() => load()).then((handler) => handler(args, context));

/** The one public command authority: execution, discoverability, and detailed help routing. */
export const commandDefinitions: readonly CommandDefinition[] = [
  { name: "init", usage: "init [options]", summaryKey: "command.init", visibility: "default", handler: lazyHandler(() => import("./init").then((module) => module.initCommand)), helpKey: "help.init" },
  { name: "context", usage: "context [--json]", summaryKey: "command.context", visibility: "default", handler: lazyHandler(() => import("./context").then((module) => module.contextCommand)), helpKey: "help.context" },
  { name: "contract", usage: "contract [--json]", summaryKey: "command.contract", visibility: "default", handler: lazyHandler(() => import("./contract").then((module) => module.contractCommand)), helpKey: "help.contract" },
  { name: "scan", usage: "scan [--report] [glob...]", summaryKey: "command.scan", visibility: "default", handler: lazyHandler(() => import("./scan").then((module) => module.scanCommand)), helpKey: "help.scan" },
  { name: "review", usage: "review [--evolution]", summaryKey: "command.review", visibility: "default", handler: lazyHandler(() => import("./review").then((module) => module.reviewCommand)), helpKey: "help.review" },
  { name: "check", usage: "check [--worktree|--staged] [--semantic] [--report] [--verbose] [--tests] [--record-config]", summaryKey: "command.check", visibility: "default", handler: lazyHandler(() => import("./check").then((module) => module.checkCommand)), helpKey: "help.check" },
  { name: "rules", usage: "rules <action>", summaryKey: "command.rules", visibility: "default", handler: lazyHandler(() => import("./rules").then((module) => module.rulesCommand)), helpKey: "help.rules" },
  { name: "docs", usage: "docs <action>", summaryKey: "command.docs", visibility: "default", handler: lazyHandler(() => import("./docs").then((module) => module.docsCommand)), helpKey: "help.docs", actionHelpKeys: { record: "help.record" } },
  { name: "toolchains", usage: "toolchains [--json]", summaryKey: "command.toolchains", visibility: "default", handler: lazyHandler(() => import("./toolchains").then((module) => module.toolchainsCommand)), helpKey: "help.toolchains" },
  { name: "test", usage: "test [--list] [--bloat] [--json]", summaryKey: "command.test", visibility: "default", handler: lazyHandler(() => import("./test").then((module) => module.testCommand)), helpKey: "help.test" },
  { name: "update", usage: "update [--json]", summaryKey: "command.update", visibility: "default", handler: lazyHandler(() => import("./update").then((module) => module.updateCommand)), helpKey: "update.usage" },
  { name: "calibration", usage: "calibration export test", summaryKey: "command.calibration", visibility: "advanced", handler: lazyHandler(() => import("./calibration").then((module) => module.calibrationCommand)) },
  { name: "coordination", usage: "coordination <action>", summaryKey: "command.coordination", visibility: "advanced", handler: lazyHandler(() => import("./coordination").then((module) => module.coordinationCommand)), helpKey: "help.coordination" },
  { name: "lsp", usage: "lsp <start|stop|status>", summaryKey: "command.lsp", visibility: "advanced", handler: lazyHandler(() => import("./lsp").then((module) => module.lspCommand)) },
  { name: "anti-patterns", usage: "anti-patterns [--report]", summaryKey: "command.antiPatterns", visibility: "advanced", handler: lazyHandler(() => import("./antiPatterns").then((module) => module.antiPatternsCommand)) },
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
