// packages/core/src/infra/paths.ts
// 集中管理 .openarch/ 路径，统一读取 OPENARCH_BASE_DIR 环境变量。
// 所有 application 层文件通过此模块获取路径，避免硬编码。
import { resolve, relative, isAbsolute } from "node:path";

/** 返回 .openarch 根目录（受 OPENARCH_BASE_DIR 控制） */
export const openarchBase = (): string => process.env.OPENARCH_BASE_DIR ?? ".openarch";

/** 项目根目录（.openarch 的父目录） */
export const projectRoot = (): string => resolve(openarchBase(), "..");

/** 绝对路径 → 仓库相对路径（baseline/implicit-deps 持久化用，跨机器可移植） */
export const toRelative = (absPath: string): string => {
  try {
    return relative(projectRoot(), absPath).replace(/\\/g, "/");
  } catch {
    return absPath;
  }
};

/** 仓库相对路径 → 绝对路径（运算用——graph/reach 需要绝对路径做节点 key）。
 *  统一 normalize 分隔符为 `/`，与 graph.ts 的 map 函数对齐。 */
export const toAbsolute = (relPath: string): string => {
  if (isAbsolute(relPath)) return relPath.replace(/\\/g, "/");
  return resolve(projectRoot(), relPath).replace(/\\/g, "/");
};

/** .openarch/baseline */
export const baselineDir = (): string => `${openarchBase()}/baseline`;

/** .openarch/baseline/_index.json */
export const baselineIndex = (): string => `${baselineDir()}/_index.json`;

/** .openarch/config.yml */
export const configPath = (): string => `${openarchBase()}/config.yml`;

/** .openarch/history */
export const historyDir = (): string => `${openarchBase()}/history`;

/** .openarch/docs-repo */
export const docsRepoDir = (): string => `${openarchBase()}/docs-repo`;

/**
 * Local coordination endpoint selection. This is deliberately separate from
 * the Git DocumentStore association: a docs repository is durable shared
 * state, while a coordinator is an optional live service.
 */
export const coordinationConfigPath = (cwd: string = process.cwd()): string =>
  resolve(cwd, openarchBase(), "coordination.json");

/** .openarch/implicit-deps.yml（发现的隐式依赖落地文件，纳入 git） */
export const implicitDepsPath = (): string => `${openarchBase()}/implicit-deps.yml`;

/** .openarch/implicit-deps/rules/（构建后的可执行规则 mjs 目录） */
export const implicitDepsRulesDir = (): string => `${openarchBase()}/implicit-deps/rules`;
/** .openarch/test-governance/rules/（项目测试语义 finding 脚本） */
export const testGovernanceRulesDir = (): string => `${openarchBase()}/test-governance/rules`;
/** .openarch/anti-patterns/rules/（report-only 结构反模式脚本） */
export const antiPatternRulesDir = (): string => `${openarchBase()}/anti-patterns/rules`;
