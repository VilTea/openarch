import { findCommand } from "./commands/index";
import { resetChangeSetCache } from "@openarch/core";
import { hasHelpFlag, helpCommand, isHelpCommand } from "./commands/help";
import { message, resolveLocale } from "./i18n";
import { pathToFileURL } from "node:url";
import { OPENARCH_VERSION } from "./version";

const VERSION_FLAGS = new Set(["--version", "-v"]);

const printVersion = (): number => {
  console.log(OPENARCH_VERSION);
  return 0;
};

/** Public process boundary. Command implementations remain independently testable TypeScript. */
export const runCli = (
  rawArgv: readonly string[] = process.argv.slice(2),
  cwd = process.cwd(),
): Promise<number> => {
  if (rawArgv.some((arg) => VERSION_FLAGS.has(arg))) return Promise.resolve(printVersion());
  const localeResolution = resolveLocale(rawArgv, cwd);
  if (localeResolution.error) {
    console.error(localeResolution.error);
    return Promise.resolve(3);
  }
  const [commandName, ...args] = localeResolution.args;
  const context = { cwd, rawArgv, locale: localeResolution.locale };
  if (isHelpCommand(commandName)) return Promise.resolve(helpCommand(args, context));
  if (hasHelpFlag(args)) return Promise.resolve(helpCommand([commandName, ...args.filter((arg) => arg !== "--help" && arg !== "-h")], context));
  const handler = findCommand(commandName);
  if (!handler) {
    console.error(message(localeResolution.locale, "command.unknown", { command: commandName ?? "" }));
    return Promise.resolve(3);
  }
  return Promise.resolve()
    // D-G17b：进程内变更集备忘录在每次命令派发前清一次。CLI 进程通常只跑一条命令，
    // 但嵌入式宿主（DSH 插件、以及在同一进程里连续调用命令的测试）会复用模块状态——
    // 不在这里清除就会让上一条命令的 git 快照串到下一条。
    .then(() => { resetChangeSetCache(); })
    .then(() => handler(args, context))
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`OpenArch command failed: ${detail}`);
      return 3;
    });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli();
}
