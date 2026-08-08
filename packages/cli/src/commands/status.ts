import { Effect, Option } from "effect";
import { ScanProgressService, governanceReadiness, scanProgressLifecycle, status } from "@openarch/core";
import { CommandHandler, LiveLayer } from "../runtime";
import { message } from "../i18n";
import { readinessMessage } from "./context";

export const statusCommand: CommandHandler = async (args, context) => {
  const locale = context.locale;
  const result = status(context.cwd);
  console.log(message(locale, "status.heading"));
  console.log(message(locale, "status.baseline", { state: result.baseline.exists ? message(locale, "status.present") : message(locale, "status.missing") }));
  if (result.baseline.exists) {
    console.log(message(locale, "status.files", { files: result.baseline.nFiles }));
  }
  console.log(message(locale, "status.docsRepo", { state: result.docsRepo.associated ? message(locale, "status.associated", { type: result.docsRepo.type ?? "unknown" }) : message(locale, "status.unassociated") }));
  if (result.docsRepo.associated && (result.docsRepo.behind ?? 0) > 0) {
    console.log(message(locale, "status.behind", { commits: result.docsRepo.behind ?? 0 }));
  }
  console.log(message(locale, "status.store", { state: result.documentStore.configured ? `${result.documentStore.mode} (${result.documentStore.root})` : message(locale, "status.unconfigured") }));
  if (result.documentStore.configured && result.documentStore.scopeConfigured === false) {
    console.log(message(locale, "status.scopeUnavailable"));
  }
  if (args.includes("--verify")) {
    console.log(message(locale, "status.readiness"));
    for (const readiness of governanceReadiness(context.cwd).items) {
      console.log(`- [${readiness.state.toUpperCase()}] ${readiness.id}: ${readinessMessage(locale, readiness.reason)}`);
    }
  }
  const progress = await Effect.runPromise(Effect.gen(function* () {
    const service = yield* ScanProgressService;
    return yield* Effect.option(service.read());
  }).pipe(Effect.provide(LiveLayer)));
  if (Option.isSome(progress) && progress.value) {
    const value = progress.value;
    const statusLabel = scanProgressLifecycle(value) === "stale" ? message(locale, "status.scanStale") : value.status.toUpperCase();
    console.log(message(locale, "status.scan", { status: statusLabel, phase: value.phase, completed: value.completed, total: value.total, files: value.nFiles === undefined ? "" : ` (${message(locale, "status.files", { files: value.nFiles }).slice(2)})` }));
    if (value.reason) console.log(message(locale, "status.reason", { reason: value.reason }));
  }
  return 0;
};
