#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const loader = pathToFileURL(require.resolve("tsx")).href;
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const result = spawnSync(process.execPath, ["--import", loader, entry, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
