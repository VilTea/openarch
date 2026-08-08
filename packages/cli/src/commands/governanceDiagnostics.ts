import { Effect } from "effect";
import { evaluateGovernance } from "@openarch/core";
import { renderGovernanceDiagnostics } from "../report/governanceDiagnosticsReport";
import { type Locale } from "../i18n";
import { LiveLayer } from "../runtime";

/** One read-only projection shared by review and scan --report. */
export const governanceDiagnostics = async (locale: Locale): Promise<
  { readonly lines: readonly string[] } | { readonly unavailable: string }
> => {
  try {
    const result = await Effect.runPromise(evaluateGovernance().pipe(Effect.provide(LiveLayer)));
    return { lines: renderGovernanceDiagnostics(result, locale) };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
};
