import { readFileSync } from "node:fs";

declare const __OPENARCH_VERSION__: string | undefined;

const bundledVersion = typeof __OPENARCH_VERSION__ === "string" ? __OPENARCH_VERSION__ : undefined;
const manifest = bundledVersion
  ? { version: bundledVersion }
  : JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { readonly version?: unknown };

if (typeof manifest.version !== "string" || manifest.version.length === 0) {
  throw new Error("CLI package.json must declare a version");
}

/** Version from the installed CLI package, not a second source-level literal. */
export const OPENARCH_VERSION = manifest.version;
