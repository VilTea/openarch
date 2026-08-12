import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ModuleResolver } from "./ModuleResolver";

interface CargoContext {
  readonly rootDir: string;
  readonly sourceDir: string;
}

const cargoContextCache = new Map<string, CargoContext | null>();

const cargoContextFor = (startDir: string): CargoContext | null => {
  if (cargoContextCache.has(startDir)) return cargoContextCache.get(startDir) ?? null;
  let current = resolve(startDir);
  while (true) {
    const cargoToml = join(current, "Cargo.toml");
    if (existsSync(cargoToml)) {
      const manifest = readFileSync(cargoToml, "utf8");
      const sourceDir = join(current, "src");
      const context = /\[package\]/.test(manifest) && existsSync(sourceDir) ? { rootDir: current, sourceDir } : null;
      if (context) cargoContextCache.set(startDir, context);
      return context;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // 不缓存 null（2026-08-12 修复，与 JavaModuleResolver 对齐）：Cargo.toml 可能在
  // 首次解析后出现，缓存 null 会让新增 Cargo.toml 的项目永久解析失败。
  return null;
};

const moduleFiles = (baseDir: string, segments: readonly string[]): readonly string[] => {
  for (let end = segments.length; end > 0; end -= 1) {
    const stem = join(baseDir, ...segments.slice(0, end));
    const candidates = [`${stem}.rs`, join(stem, "mod.rs")];
    const found = candidates.find(existsSync);
    if (found) return [resolve(found).replace(/\\/g, "/")];
  }
  return [];
};

/**
 * Cargo exposes the crate root, but Rust module declarations can remap files.
 * Only the conventional src/<module>.rs and src/<module>/mod.rs shapes are proven
 * here; macro-generated or path-attribute modules deliberately remain unresolved.
 */
export const rustModuleResolver: ModuleResolver = {
  resolveLocal: (filePath, source) => {
    const context = cargoContextFor(dirname(filePath));
    if (!context) return [];
    const segments = source.split("::").filter(Boolean);
    if (segments[0] === "crate") return moduleFiles(context.sourceDir, segments.slice(1));

    if (segments[0] === "self" || segments[0] === "super") {
      const sourceRelative = relative(context.sourceDir, filePath);
      const moduleDir = dirname(sourceRelative);
      let base = resolve(context.sourceDir, moduleDir);
      let offset = 0;
      while (segments[offset] === "super") { base = dirname(base); offset += 1; }
      if (segments[offset] === "self") offset += 1;
      return moduleFiles(base, segments.slice(offset));
    }
    return [];
  },
};
