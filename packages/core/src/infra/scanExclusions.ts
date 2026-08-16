// packages/core/src/infra/scanExclusions.ts
// 扫描总体卫生的固定产品边界（校准 2026-08-15）：构建产物、依赖与运行时目录
// 不是可治理源码。它们不是项目配置——file_kinds 无法把它们重新纳入扫描。
// 需要治理生成代码时，应把生成器输出复制到显式源码目录后扫描。
export const SCAN_EXCLUDED_SEGMENTS = [
  "/node_modules/",
  "/.git/",
  "/.openarch/",
  "/dist/",
  "/coverage/",
  "/vendor/",
  "/target/",
  "/build/",
  "/out/",
  "/.venv/",
  "/venv/",
  "/.next/",
  "/.turbo/",
  "/.cache/",
  "/bazel-out/",
] as const;

export const SCAN_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(
  SCAN_EXCLUDED_SEGMENTS.map((segment) => segment.slice(1, -1)),
);
