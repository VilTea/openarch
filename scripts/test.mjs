// Test runner wrapper: separates hermetic unit tests from integration tests.
//   pnpm test              -> unit scope
//   pnpm test:unit         -> unit scope
//   pnpm test:integration  -> integration scope
// The scope is exposed as OPENARCH_TEST_SCOPE so tests can skip/select
// accordingly. Integration tests must not run in the default unit scope.
import { spawnSync } from "node:child_process";

const scope = process.argv[2] ?? "unit";
if (scope !== "unit" && scope !== "integration") {
  console.error(`Unknown test scope: ${scope}`);
  process.exit(2);
}

const pnpmEntry = process.env.npm_execpath;
const command = pnpmEntry ? process.execPath : process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = pnpmEntry ? [pnpmEntry, "-r", "test"] : ["-r", "test"];
const result = spawnSync(command, args, {
  stdio: "inherit",
  env: { ...process.env, OPENARCH_TEST_SCOPE: scope },
  windowsHide: true,
});
process.exit(result.status ?? 1);
