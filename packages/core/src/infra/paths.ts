// packages/core/src/infra/paths.ts
// 集中管理 .openarch/ 路径，统一读取 OPENARCH_BASE_DIR 环境变量。
// 所有 application 层文件通过此模块获取路径，避免硬编码。
//
// 跨平台路径规范（2026-08-10 治理）：统一使用 pathe（unjs，Nuxt/Vite 同源）
// 处理目录字符串，禁止散落手写正则。Windows 盘符大小写、分隔符差异由
// pathe 一处解决：pathe 在 Windows 上把盘符规范为大写（e:/a → E:/a）、
// 分隔符统一为 `/`，POSIX 上保持原样——同一函数在所有平台产出同形 key。
import { resolve, relative, isAbsolute } from "node:path";
import { resolve as patheResolve } from "pathe";

/** 返回 .openarch 根目录（受 OPENARCH_BASE_DIR 控制） */
export const openarchBase = (): string => process.env.OPENARCH_BASE_DIR ?? ".openarch";

/** 项目根目录（.openarch 的父目录） */
export const projectRoot = (): string => resolve(openarchBase(), "..");

/**
 * 纯分隔符规范化：`\` → `/`。等价于旧 `path.replace(/\\/g, "/")` 的语义
 * （不做 `..` 解析、不 resolve），用于仓库相对路径/输出的展示与比较。
 * pathe 是 POSIX-first：所有 pathe 函数要求输入已为 `/` 分隔（否则 `\f`
 * 之类会被当转义序列），因此本函数是所有调用点进入 pathe 前的唯一转换口。
 */
export const toPosixPath = (path: string): string => path.replace(/\\/g, "/");

/**
 * 绝对路径 key：先转 POSIX 分隔符，再交给 pathe resolve——统一盘符大小写
 * （Windows: `e:\a\b` / `E:/a/b` / `E:\a\b` 全部 → `E:/a/b`）与 `..` 解析。
 * graph 节点、baseline 条目、inDegree 查表必须全部经此函数，否则 Windows
 * 盘符大小写差异导致 key miss（A1 修复：graph.ts 的 map 与 scanEntries 的
 * norm 此前一处小写一处原样，inDegree 查表全 miss → 全 0）。
 */
export const absolutePathKey = (path: string, basePath = "."): string =>
  patheResolve(basePath, toPosixPath(path));

/** 绝对路径 → 仓库相对路径（baseline/implicit-deps 持久化用，跨机器可移植） */
export const toRelative = (absPath: string): string => {
  try {
    return toPosixPath(relative(projectRoot(), absPath));
  } catch {
    return absPath;
  }
};

/** 仓库相对路径 → 绝对路径（运算用——graph/reach 需要绝对路径做节点 key）。
 *  统一 normalize 分隔符为 `/` 且盘符大写，与 graph.ts 的节点 key 对齐。 */
export const toAbsolute = (relPath: string): string => {
  if (isAbsolute(relPath)) return absolutePathKey(relPath);
  return absolutePathKey(relPath, projectRoot());
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
