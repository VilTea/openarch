// packages/core/src/application/pathClass.ts
// path_class 解析 + 层权重查询（gateApp + diff 共用，DRY）。
// design v5.3 §7.2 因子4 ω_layer：文件路径 → 层权重，接入 I_push 乘法。
import { minimatch } from "minimatch";

/** Shared project classification, independent of gate evaluation. */
export interface PathClass {
  readonly pattern: string;
  readonly name: string;
  readonly weight?: number;   // ω_layer，缺省 1.0
}

export const classifyPath = (filePath: string, paths: readonly PathClass[]): string => {
  const normalize = (value: string): string => value.replace(/\\/g, "/");
  const normalizedPath = normalize(filePath);
  for (const path of paths) {
    if (minimatch(normalizedPath, normalize(path.pattern))) return path.name;
  }
  return "default";
};

interface PathConfigEntry {
  readonly pattern: string;
  readonly weight?: number;
}

/** 从已解析的 config 对象提取 path_class 列表（纯函数）。
 *  无 default 时自动补 { pattern: "**", name: "default" }。 */
export const parsePathClasses = (cfg: { paths?: Record<string, PathConfigEntry> }): PathClass[] => {
  const entries: PathClass[] = cfg.paths
    ? Object.entries(cfg.paths)
      .filter(([, v]) => v.pattern)
      .map(([k, v]) => ({ pattern: v.pattern, name: k, weight: v.weight }))
    : [];
  if (!entries.some(p => p.name === "default")) {
    entries.push({ pattern: "**", name: "default" });
  }
  return entries;
};

/** 查文件的层权重：classifyPath 得 name → 查 weight，缺省 1.0。
 *  非法值（负/NaN）clamp 到 0.1 防极端放大。 */
export const layerWeightOf = (filePath: string, classes: readonly PathClass[]): number => {
  const name = classifyPath(filePath, classes);
  const w = classes.find(c => c.name === name)?.weight;
  if (w === undefined || !Number.isFinite(w)) return 1.0;
  return Math.max(0.1, w);
};
