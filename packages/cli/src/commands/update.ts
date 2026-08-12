import { checkForUpdates } from "@openarch/core";
import { message } from "../i18n";
import { OPENARCH_VERSION } from "../version";
import type { CommandHandler } from "../runtime";

/**
 * Version update check (2026-08-10): compares the installed version against
 * the release branch's CLI package.json. Read-only — updates are explicit
 * user actions (download the release binary, re-run init --agent).
 */
export const updateCommand: CommandHandler = async (args, context) => {
  if (args.length > 0 && !args.every((arg) => arg === "--json")) {
    console.error(message(context.locale, "update.usage"));
    return 3;
  }
  const json = args.includes("--json");
  try {
    const result = await checkForUpdates(OPENARCH_VERSION);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (result.updateAvailable) {
      console.log(message(context.locale, "update.available", { current: result.current, latest: result.latest }));
      console.log(message(context.locale, "update.action"));
    } else {
      console.log(message(context.locale, "update.upToDate", { version: result.current }));
    }
    return 0;
  } catch (error) {
    console.error(message(context.locale, "update.failed", { detail: error instanceof Error ? error.message : String(error) }));
    return 1;
  }
};
