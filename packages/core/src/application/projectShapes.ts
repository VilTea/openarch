/**
 * 项目语言形状的**读取唯一入口**（应用层）：只经由 config.yml 的读取权威
 * `readProjectConfig`（D-G13），不自己 `readFileSync` + `load`。
 *
 * 为什么不把解析放在调用方：`shapes` 的**形状校验**（严格解析、未接线类别报错）是同一份知识，
 * 若 `scan`/`gate`/`test` 各写一遍，三者对"声明了 `assertion_methods`"的处理必然漂移
 * （正是 D-G13 记录的缺陷形状）。
 *
 * 返回 `source`（`project` / `builtin`）：报告必须披露当前生效的是哪一份名单（§6/Q1）。
 * `errors` 非空表示声明**不可用**：调用方必须上报（fail-closed），不得当"未声明"继续
 * ——否则就出现"身份变了、判断没变"的静默不一致。
 */
import { projectConfigPath, readProjectConfig, type ProjectConfigRead } from "../projectFiles";
import {
  parseLanguageShapes,
  shapesFingerprintOf,
  shapesSourceOf,
  type LanguageShapeError,
  type ProjectShapes,
  type ShapesSource,
} from "../domain/languageShapes";

export interface ProjectShapesRead {
  /** 已校验的形状（`errors` 非空时**不得**用于判断）。 */
  readonly byLanguage: ProjectShapes;
  /** 身份指纹；未声明 ⇒ `""`（与"记录里没有该字段"同一语义 ⇒ 零迁移）。 */
  readonly fingerprint: string;
  /** 生效来源：`project` = 项目声明；`builtin` = 内置默认。 */
  readonly source: ShapesSource;
  /** 声明错误（空数组 = 无错误）。 */
  readonly errors: readonly LanguageShapeError[];
}

const empty = (errors: readonly LanguageShapeError[] = []): ProjectShapesRead =>
  ({ byLanguage: {}, fingerprint: "", source: "builtin", errors });

/** 从一次已完成的 config 读取投影形状（供同样走 `readProjectConfig` 的调用方复用，避免重复读盘）。 */
export const projectShapesOfRead = (read: ProjectConfigRead): ProjectShapesRead => {
  if (read.status !== "ok") return empty();
  const parsed = parseLanguageShapes((read.value as { shapes?: unknown } | undefined)?.shapes);
  const fingerprint = shapesFingerprintOf(parsed.shapes);
  return { byLanguage: parsed.shapes, fingerprint, source: shapesSourceOf(fingerprint), errors: parsed.errors };
};

/** 读取项目形状（路径默认 `<cwd>/.openarch/config.yml`，与 `readProjectConfig` 同源）。 */
export const readProjectShapes = (path: string = projectConfigPath()): ProjectShapesRead =>
  projectShapesOfRead(readProjectConfig(path));

/** 声明错误的单行诊断（CLI / gate 共用同一措辞，避免两处各自造句）。 */
export const languageShapeErrorsText = (errors: readonly LanguageShapeError[]): string =>
  errors.map((error) => `${error.path}: ${error.message}`).join("; ");
