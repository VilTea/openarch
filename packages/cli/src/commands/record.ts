import { Effect } from "effect";
import { record, resolveDocumentStore, type RecordCategory } from "@openarch/core";
import { CommandHandler, LiveLayer, parseOptionValue, printAnalysisError } from "../runtime";
import { message } from "../i18n";

const VALID_CATEGORIES = new Set<RecordCategory>(["anti_patterns", "patterns", "decisions"]);

export const recordCommand: CommandHandler = async (args, context) => {
  const locale = context.locale;
  const category = parseOptionValue(args, "--category");
  if (args.includes("--category") && (!category || !VALID_CATEGORIES.has(category as RecordCategory))) {
    console.error(message(locale, "record.invalidCategory"));
    return 3;
  }
  const titleArgs = [...args];
  const categoryIndex = titleArgs.indexOf("--category");
  if (categoryIndex >= 0) {
    titleArgs.splice(categoryIndex, 2);
  }

  const title = titleArgs[0] || `openarch-record-${new Date().toISOString().slice(0, 10)}`;
  const store = resolveDocumentStore(context.cwd);
  const outcome = await Effect.runPromise(record({
    title, ...(store ? { docsDir: store.scopeRoot } : {}),
    ...(category ? { category: category as RecordCategory } : {}),
    locale: context.locale,
  }).pipe(Effect.provide(LiveLayer), Effect.either));
  if (outcome._tag === "Left") {
    printAnalysisError(outcome.left);
    return 3;
  }
  const result = outcome.right;
  if ("error" in result) {
    console.error(result.error);
    return 3;
  }

  const recordedPath = result.filePath;
  console.log(message(locale, "record.created", { path: recordedPath, category: result.category }));
  console.log(message(locale, "record.check", { path: recordedPath }));
  console.log(message(locale, "record.commit"));
  return 0;
};
