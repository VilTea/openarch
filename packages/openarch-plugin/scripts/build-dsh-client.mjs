#!/usr/bin/env node
/**
 * Build the DSH static client bundle for @openarch/plugin.
 *
 * DSH's client-modules does NOT scan/compile source files. It serves the file
 * named by `exports["./client"]` as a classic browser script and expects that
 * script to call `window.__ModuleLoader__.load({ id, factory })`. The factory
 * is a lazy CommonJS-like closure: it receives `require`, runs only when the
 * module is materialized, and returns the plugin exports.
 *
 * This script wraps `dsh/client/openarch-dashboard.mjs` in that contract:
 * - strips ESM `export` keywords;
 * - provides `React` from the DSH seed word `"react"`;
 * - provides a small `styles.insert` shim that emits a tagged <style> element
 *   (DSH claims untagged style tags during materialization; we tag it
 *   explicitly for HMR bookkeeping);
 * - exports the same `name`/`inject`/`apply` surface as the source module.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const id = pkg.name;
const sourceFile = join(root, "dsh", "client", "openarch-dashboard.mjs");
const outputFile = join(root, "lib", "client.js");
const cssTagId = `${id}/dsh/client/openarch-dashboard.css`;

let source = readFileSync(sourceFile, "utf8");

// The source is intentionally zero-import ESM; turn its three exports into
// local declarations so the same code can live inside a CJS factory.
source = source.replace('export const name = "openarch-dashboard";', 'const name = "openarch-dashboard";');
source = source.replace(/^export const inject = (\[.*\]);/m, "const inject = $1;");
source = source.replace("export function apply(ctx, config = {}) {", "function apply(ctx, config = {}) {");

if (/^\s*export\s+(?:const|function|class|default|[{*])/m.test(source)) {
  throw new Error("build-dsh-client: source still contains ESM export statements after transformation");
}

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tconst React = require("react");
\t\tconst styles = {
\t\t\tinsert(css) {
\t\t\t\tif (typeof document === "undefined") return;
\t\t\t\tconst tagId = ${JSON.stringify(cssTagId)};
\t\t\t\tif (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
\t\t\t\tconst tag = document.createElement("style");
\t\t\t\ttag.dataset.plugin = ${JSON.stringify(id)};
\t\t\t\ttag.dataset.pluginCss = tagId;
\t\t\t\ttag.textContent = css;
\t\t\t\tdocument.head.append(tag);
\t\t\t}
\t\t};
${source}
\t\texports.name = name;
\t\texports.inject = inject;
\t\texports.apply = apply;
\t\treturn module.exports;
\t}
});
`;

mkdirSync(dirname(outputFile), { recursive: true });
writeFileSync(outputFile, bundle, "utf8");
console.log(`built ${id} client bundle -> ${outputFile}`);
