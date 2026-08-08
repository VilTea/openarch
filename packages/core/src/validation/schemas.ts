// packages/core/src/validation/schemas.ts
import { z } from "zod";
import { FILE_KINDS } from "../domain/testGovernance";
import { STRUCTURAL_CALIBRATION_BOUNDARY } from "../domain/calibration";
import { LANGUAGES } from "../domain/ast";

export const FileKindSchema = z.enum(FILE_KINDS);
export const TestFindingInputSchema = z.object({
  ruleId: z.string().min(1),
  kind: z.string().min(1),
  file: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  confidence: z.enum(["confirmed", "high", "medium", "low"]),
  testName: z.string().min(1).optional(),
  line: z.number().int().min(1).optional(),
});
export const TestMetricsSchema = z.object({
  schemaVersion: z.enum(["1", "2", "3", "4"]),
  providerId: z.string().min(1),
  tests: z.array(z.object({
    name: z.string().min(1), loc: z.number().int().min(0), assertionCount: z.number().int().min(0),
    mockCount: z.number().int().min(0), statuses: z.array(z.string()),
    testBodyControlFlow: z.number().min(0).optional(),
  })),
  findings: z.array(TestFindingInputSchema.extend({ source: z.string().min(1) })).optional(),
  moduleAssociations: z.array(z.union([
    z.object({ targetPath: z.string().min(1), source: z.string().min(1), confidence: z.literal("low") }),
    z.object({
      targetPath: z.string().min(1), source: z.string().min(1), confidence: z.literal("medium"),
      testName: z.string().min(1), symbol: z.string().min(1),
    }),
  ])).optional(),
});

const StructuralCalibrationProfileSchema = z.object({
  id: z.string().min(1), version: z.literal(STRUCTURAL_CALIBRATION_BOUNDARY.version), source: z.literal("baseline"),
  analysisScopeFingerprint: z.string().min(1), metricContractVersion: z.string().min(1), populationFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  weightsFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  p95: z.object({ branch: z.number(), nesting: z.number(), loc: z.number(), alpha: z.number(), oneMinusConnectedness: z.number(), externalPassthrough: z.number() }),
});

/** per-file JSON schema（IndexEntry） */
export const IndexEntrySchema = z.object({
  path: z.string().min(1),                        // 权威绝对路径（自描述，不再依赖文件名反解）
  language: z.enum(LANGUAGES).optional(),
  fileKind: FileKindSchema.optional(),             // 测试与生产指标/P95/gate 分轨；旧 baseline 缺省 production
  branchCount: z.number().min(0).max(1000),        // 兼容别名：加权文件总分支
  weightedBranchTotal: z.number().min(0).max(1000).optional(),
  topLevelWeightedBranch: z.number().min(0).max(1000).optional(),
  nestingDepth: z.number().int().min(0).max(200),
  inDegree: z.number().int().min(0),
  outDegree: z.number().int().min(0),
  alphaStruct: z.number().min(0).max(1),
  imports: z.array(z.string()).optional(),        // 依赖的 resolvedPath 列表（diff 重建图用）
  reexports: z.array(z.string()).optional(),      // 已确认 public re-export；仅供演化关系分类
  cohesion: z.number().min(0).max(1).optional(),   // 文件内函数间调用密度（公式6 子公式）
  passthroughCalls: z.number().int().min(0).optional(),  // 透传调用数（Confidence 输入 + CRL_state）
  loc: z.number().int().min(1).optional(),                // 文件行数（CRL_state 用）
  declarationLoc: z.number().int().min(0).optional(),     // 声明行（CRL loc 因子按实现行口径排除，校准 2026-08-08）
  maxFuncBranch: z.number().min(0).optional(),             // 单函数最大加权分支数（卫语句/case 可为小数）
  externalPassthroughCalls: z.number().int().min(0).optional(), // 已确认的直接非本地调用；成员/动态调用不计入
  connectedness: z.number().min(0).max(1).optional(),         // 函数连通度（提取helper不罚）
  /** 文件内容身份（sha256）：增量扫描变更检测基准（校准 2026-08-08）。 */
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  localBurdenFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  previousLocalBurdenFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  testMetrics: TestMetricsSchema.optional(),
});

/** _index.json schema（BaselineIndex——metadata only, no files list） */
export const BaselineIndexSchema = z.object({
  version: z.string().startsWith("5."),
  meta: z.object({
    scanAt: z.string().min(10),
    snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    sourceSnapshotSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    nFiles: z.number().int().min(0),
    nProductionFiles: z.number().int().min(0).optional(),
    nTestFiles: z.number().int().min(0).optional(),
    languages: z.array(z.string()).min(1),
    maxDepthUsed: z.number().int().min(1).max(5).optional(),
    performanceMode: z.enum(["normal", "reduced"]).optional(),
    analysisScope: z.object({ fingerprint: z.string().min(1), complete: z.boolean() }).optional(),
    metricContractVersion: z.string().min(1).optional(),
    calibration: z.object({
      current: StructuralCalibrationProfileSchema,
      previous: StructuralCalibrationProfileSchema.optional(),
      gate: StructuralCalibrationProfileSchema.optional(),
    }).optional(),
    policyCalibrations: z.record(z.object({
      current: StructuralCalibrationProfileSchema,
      previous: StructuralCalibrationProfileSchema.optional(),
      gate: StructuralCalibrationProfileSchema.optional(),
    })).optional(),
    p95: z.object({
      branch: z.number(), nesting: z.number(), loc: z.number(),
      alpha: z.number(), oneMinusConnectedness: z.number(), externalPassthrough: z.number(),
    }).optional(),
  }),
});
