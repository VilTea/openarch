import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModuleResolver } from "./ModuleResolver";

interface PythonProjectContext {
  readonly rootDir: string;
}

const projectContextCache = new Map<string, PythonProjectContext | null>();
const PROJECT_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg"] as const;

const projectContextFor = (startDir: string): PythonProjectContext | null => {
  if (projectContextCache.has(startDir)) return projectContextCache.get(startDir) ?? null;
  let current = resolve(startDir);
  while (true) {
    if (PROJECT_MARKERS.some((marker) => existsSync(join(current, marker)))) {
      const context = { rootDir: current };
      projectContextCache.set(startDir, context);
      return context;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // 不缓存 null（2026-08-12 修复，与 JavaModuleResolver 对齐）：项目标记可能在首次
  // 解析后出现，缓存 null 会让新增 pyproject.toml 的项目永久解析失败。
  return null;
};

const moduleFile = (baseDir: string, segments: readonly string[]): readonly string[] => {
  if (segments.length === 0) {
    const init = join(baseDir, "__init__.py");
    return existsSync(init) ? [resolve(init).replace(/\\/g, "/")] : [];
  }
  const modulePath = join(baseDir, ...segments);
  const candidates = [`${modulePath}.py`, join(modulePath, "__init__.py")];
  const found = candidates.find(existsSync);
  return found ? [resolve(found).replace(/\\/g, "/")] : [];
};

/**
 * Resolves only import syntax that Python itself locates from the project root
 * or the importing package. sys.path mutation, namespace packages and dynamic
 * imports remain unresolved rather than becoming speculative graph edges.
 */
export const pythonModuleResolver: ModuleResolver = {
  resolveLocal: (filePath, source) => {
    const context = projectContextFor(dirname(filePath));
    if (!context || !source) return [];

    const relative = /^(\.+)(.*)$/.exec(source);
    if (relative) {
      const [, dots, remainder] = relative;
      let baseDir = dirname(filePath);
      for (let level = 1; level < dots.length; level += 1) baseDir = dirname(baseDir);
      return moduleFile(baseDir, remainder.split(".").filter(Boolean));
    }

    return moduleFile(context.rootDir, source.split(".").filter(Boolean));
  },
};
