import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModuleResolver } from "./ModuleResolver";

const PROJECT_MARKERS = ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"] as const;
const projectRoots = new Map<string, string | null>();

const projectRootFor = (startDir: string): string | null => {
  const cached = projectRoots.get(startDir);
  if (cached !== undefined) return cached;
  let current = resolve(startDir);
  while (true) {
    if (PROJECT_MARKERS.some((marker) => existsSync(join(current, marker)))) {
      projectRoots.set(startDir, current);
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  projectRoots.set(startDir, null);
  return null;
};

/** Resolves conventional Java source roots only; classpath, generated sources and wildcard imports stay unresolved. */
export const javaModuleResolver: ModuleResolver = {
  resolveLocal: (filePath, source) => {
    if (!source || source.endsWith(".*")) return [];
    const root = projectRootFor(dirname(filePath));
    if (!root) return [];
    const relative = `${source.replace(/\./g, "/")}.java`;
    const candidates = [join(root, "src", "main", "java", relative), join(root, "src", "test", "java", relative)];
    return candidates.filter(existsSync).map((candidate) => resolve(candidate).replace(/\\/g, "/"));
  },
};
