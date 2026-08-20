// OpenArch 项目自身的定义面契约（不进 core 默认）。
// 通用判定能力在 core definitionSurfaceContracts.ts；这里是项目级声明：
// 语义关系 provider 必须接入共享 LSP 流水线。
// LSP 流水线只约束 LSP 型 provider；TypeScript provider 走 compiler/静态路径，
// 不在这条契约内。
const ROLE_SUFFIXES = [
  "PythonSemanticRelationProvider.ts",
  "GoSemanticRelationProvider.ts",
  "JavaSemanticRelationProvider.ts",
  "RustSemanticRelationProvider.ts",
];
const AUTHORITY_SUFFIX = "semanticRelationPipeline.ts";
const REQUIRED_IMPORT = "./semanticRelationPipeline";

const isRoleFile = (file) => ROLE_SUFFIXES.some((suffix) => file.endsWith(suffix));

export default {
  scope: "repository",
  stages: {
    text: ({ files }) => files.filter((file) =>
      isRoleFile(file) || file.endsWith(AUTHORITY_SUFFIX)),
    ast: { fact: "static-imports.v1" },
  },
  link({ records }) {
    const authorityExists = records.some((record) =>
      typeof record._file === "string" && record._file.endsWith(AUTHORITY_SUFFIX));
    if (!authorityExists) return [];

    const importsByFile = new Map();
    for (const record of records) {
      if (typeof record._file !== "string" || typeof record.source !== "string") continue;
      const existing = importsByFile.get(record._file) ?? [];
      existing.push(record.source);
      importsByFile.set(record._file, existing);
    }

    const hits = [];
    const roleFiles = new Set(records
      .filter((record) => typeof record._file === "string" && isRoleFile(record._file))
      .map((record) => record._file));
    for (const file of roleFiles) {
      const imports = importsByFile.get(file) ?? [];
      if (imports.some((source) => source === REQUIRED_IMPORT)) continue;
      hits.push({
        ruleId: "definition-surface-contracts",
        file,
        message: `未接入共享模块 ${REQUIRED_IMPORT}；疑似平行实现`,
        evidence: `authority=${AUTHORITY_SUFFIX}; requiredImport=${REQUIRED_IMPORT}`,
      });
    }
    return hits;
  },
};
