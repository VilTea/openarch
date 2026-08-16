import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModuleResolver } from "./ModuleResolver";

interface GoModuleContext {
  readonly modulePath: string;
  readonly rootDir: string;
}

const moduleCache = new Map<string, GoModuleContext | null>();

const readModuleContext = (startDir: string): GoModuleContext | null => {
  if (moduleCache.has(startDir)) return moduleCache.get(startDir) ?? null;
  let current = resolve(startDir);
  while (true) {
    const goModPath = join(current, "go.mod");
    if (existsSync(goModPath)) {
      const match = readFileSync(goModPath, "utf8").match(/^\s*module\s+(\S+)\s*$/m);
      const context = match ? { modulePath: match[1], rootDir: current } : null;
      moduleCache.set(startDir, context);
      return context;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // 不缓存 null：长驻进程中项目稍后新增 go.mod 时应重新解析成功。
  return null;
};

/** Resolves a Go module-local package to its non-test source files. */
export const goModuleResolver: ModuleResolver = {
  resolveLocal: (filePath, source) => {
    const context = readModuleContext(dirname(filePath));
    if (!context || !(source === context.modulePath || source.startsWith(`${context.modulePath}/`))) return [];
    const relativeDir = source === context.modulePath ? "" : source.slice(context.modulePath.length + 1);
    const packageDir = resolve(context.rootDir, relativeDir);
    if (!existsSync(packageDir)) return [];
    return readdirSync(packageDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".go") && !entry.name.endsWith("_test.go"))
      .map((entry) => resolve(packageDir, entry.name).replace(/\\/g, "/"))
      .sort();
  },
};
