import { Effect } from "effect";
import { SemanticToolchainDiscovery, SemanticToolchainDiscoveryLive, readProjectLanguages, toolchainConfigPaths } from "@openarch/core";
import { message } from "../i18n";
import { type CommandHandler } from "../runtime";

const collect = (cwd: string) => Effect.gen(function* () {
  const discovery = yield* SemanticToolchainDiscovery;
  return yield* discovery.discover({ cwd, languages: readProjectLanguages(cwd) });
});

/** Read-only external-toolchain facts and their configuration locations. */
export const toolchainsCommand: CommandHandler = async (args, context) => {
  if (args.some((arg) => arg !== "--json")) {
    console.error(message(context.locale, "toolchains.usage"));
    return 3;
  }
  const config = toolchainConfigPaths(context.cwd, { platform: process.platform, environment: process.env });
  const reports = await Effect.runPromise(collect(context.cwd).pipe(Effect.provide(SemanticToolchainDiscoveryLive)));
  if (args.includes("--json")) {
    console.log(JSON.stringify({ configuration: config, reports }, null, 2));
    return 0;
  }
  console.log(message(context.locale, "toolchains.heading"));
  console.log(message(context.locale, "toolchains.userConfig", { path: config.user ?? message(context.locale, "toolchains.userConfigUnavailable") }));
  console.log(message(context.locale, "toolchains.projectConfig", { path: config.project }));
  if (reports.length === 0) console.log(message(context.locale, "toolchains.languagesMissing"));
  for (const report of reports) {
    console.log(message(context.locale, "toolchains.language", { language: report.language, availability: report.availability.toUpperCase() }));
    for (const tool of report.tools) {
      console.log(message(context.locale, "toolchains.tool", {
        id: tool.id,
        availability: tool.availability.toUpperCase(),
        location: tool.location ?? "-",
        detail: tool.reason ? ` (${tool.reason})` : "",
      }));
    }
  }
  return 0;
};
