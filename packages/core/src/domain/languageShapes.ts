/**
 * 可配置**语言形状**的纯权威（域层，无 IO）。
 *
 * 背景（项目所有者 2026-09-27 批准，见内部事实契约草案 §6）：
 * "语言形状"（哪些调用算弱断言、哪些算断言入口）此前只存在于 core 的硬编码集合里，
 * 项目自有断言库（AssertJ、Truth、自研 helper）无法声明；OpenArch 只能按内置名单猜。
 *
 * 契约决策（§6，五项全取倾向项）：
 * - **Q1 覆盖**：项目声明了某一类形状就用它；内置名单只作为**未声明时的默认**。
 *   与 `file_kinds`（显式规则优先）同构 ⇒ 一个概念一个入口。报告必须**披露**当前生效的是
 *   "项目声明"还是"内置默认"（否则又是一句与事实不符的陈述）。
 * - **Q2 独立身份**：声明了 shapes 的项目把 `shapesFingerprint` 写进 baseline meta；
 *   兼容判据由唯一权威 `application/baselineCompatibility` **同时消费 scope 与 shapes**。
 *   默认（未声明）⇒ 指纹为空 ⇒ 现有项目**零迁移**（不进 `createAnalysisScope` 的 scope 指纹，
 *   不升 `scope-v3`）。
 * - **Q3 不新增 `test_file_patterns`**：测试文件识别决定 population，population 已有唯一入口
 *   （`file_kinds` 规则 + provider `supports()`）。本模块**不含**该类别，也不得新增。
 * - **Q4/Q5**：阈值不随形状走（`weakAssertionRatio` 仍是 0.03）——声明形状只改变
 *   "哪些调用被算作弱断言"，不改变阈值语义、不新增阈值维度。
 *
 * v1 只接线 `weak_assertion_methods`，且只接线**判据真正消费的两个键**（`java`、`typescript`）。
 * 草案 §2 的另两类（`assertion_methods`、`fixture_call_patterns`）**刻意不接线**：接受它们会改变
 * 身份（指纹变化、baseline 失效）却不改变判断（判据仍用内置名单）——那是"身份变了、事实没变"的
 * 静默不一致。因此本次裁剪为**声明即错误**（fail-closed），见 `parseLanguageShapes` 的 `not_wired`。
 *
 * 同一原则**同样适用于语言键**（2026-09-27 复验补充，独立 e2e 发现）：声明一个"没有判据对应"的
 * 语言键（`python`/`go`/`rust`，或错拼的 `ts`）同样只改身份不改判断——实测会写出非空
 * `shapesFingerprint` 而 `test --bloat` 照旧打印"内置默认（未声明 shapes）"，即报告里出现一句
 * **与事实不符的陈述**。故 v1 用 `WIRED_SHAPE_LANGUAGES` 白名单 fail-closed。
 *
 * **键的口径 = 断言语法族，不是任意 `languages` id**：判据按扩展名分族
 * （`assertionSyntaxLanguageFor`：`.java`→java，`.ts/.tsx/.js/.jsx/.mjs/.cjs/.vue`→ts），
 * 而消费方 `weakAssertionPatternsFor` 只读 `java` / `typescript` 两个字面键。因此
 * **JS/Vue 项目也写 `shapes.typescript`**（它是 js/ts/vue 族的键名），写 `shapes.javascript`
 * 或 `shapes.vue` 会被拒绝并给出提示。新增族必须与判据**同时**接线，否则又是第二处认知点。
 */

/** 已接线的形状类别（v1 只有一类；新增类别必须同时接线判据，否则是第二处认知点）。 */
export const WIRED_SHAPE_CLASSES = ["weak_assertion_methods"] as const;

/**
 * 已接线的**语言键**（= 断言语法族名，2026-09-27）：`weakAssertionPatternsFor` 只消费这两个键。
 * 不在其中的语言键一律拒绝——接受它们只改身份不改判断（见模块头的复验发现）。
 */
export const WIRED_SHAPE_LANGUAGES = ["java", "typescript"] as const;

/** 同族但键名不同的 `languages` id：给出"该写哪个键"的提示，避免用户只看到一句拒绝。 */
const SHAPE_LANGUAGE_HINTS: Readonly<Record<string, string>> = {
  javascript: "the js/ts/vue assertion family is declared as `typescript`",
  vue: "the js/ts/vue assertion family is declared as `typescript`",
};

/** 草案 §2 已命名但**未接线**的类别：声明它们必须报错，绝不静默接受。 */
export const NOT_WIRED_SHAPE_CLASSES = ["assertion_methods", "fixture_call_patterns"] as const;

export interface LanguageShapes {
  /** 低信息量（弱）断言方法名。声明即**覆盖**该语言的内置名单（§6/Q1）。 */
  readonly weakAssertionMethods: readonly string[];
}

/** 断言语法族 → 形状（键见 `WIRED_SHAPE_LANGUAGES`；**不是**任意 `languages` id）。 */
export interface ProjectShapes {
  readonly [language: string]: LanguageShapes | undefined;
}

/** 形状来源：`project` = 项目声明生效；`builtin` = 内置默认（未声明）。 */
export type ShapesSource = "project" | "builtin";

/** 形状声明错误（fail-closed：调用方必须上报，绝不退化成"未声明"）。 */
export interface LanguageShapeError {
  /** 出错位置（如 `shapes.java.assertion_methods`），供项目直接定位。 */
  readonly path: string;
  /** 机器可读分类：`not_wired` = 名字合法但 v1 未接线（**将来可能接线**，如 `assertion_methods`）；
   *  `unknown_shape_class` = 根本不是已知类别（**永不会接线**，如 `test_file_patterns`）；
   *  `invalid_language_key` = 语言键不是合法语言 id；其余为形状/类型错误。
   *  两者必须分开：把"永不会接线"报成"本版未接线"会让人等一个不会到来的版本。 */
  readonly kind: "not_wired" | "unknown_shape_class" | "invalid_language_key" | "invalid_value";
  /** 人类可读原因（英文，与仓库其它诊断 token 一致）。 */
  readonly message: string;
}

/** 语言 id 判据与 `structural_policies[].languages` 同源口径（小写开头，无空白）。 */
const LANGUAGE_KEY = /^[a-z][a-z0-9_+-]*$/;

const isPlainMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 单个形状类别的解析：返回名字列表**或**一条错误（二者互斥）。
 *
 * 拆出来的理由（门禁信号，不是审美）：`parseLanguageShapes` 加上语言白名单后
 * `max_func_branch` 6.6 越过了本仓 `domain > 5` 的强制规则——规则量的是**每函数最大值**，
 * 因此正确的回应是分解职责（校验类别 / 校验语言键 / 汇总），不是放宽阈值。
 */
const parseShapeClass = (
  classPath: string,
  shapeClass: string,
  rawNames: unknown,
): { readonly names?: readonly string[]; readonly error?: LanguageShapeError } => {
  if (!(WIRED_SHAPE_CLASSES as readonly string[]).includes(shapeClass)) {
    const named = (NOT_WIRED_SHAPE_CLASSES as readonly string[]).includes(shapeClass);
    return {
      error: {
        path: classPath,
        kind: named ? "not_wired" : "unknown_shape_class",
        message: named
          ? `${classPath} is not yet wired in this version: declaring it would change baseline identity without changing judgement; not accepted`
          : `${classPath} is not a known shape class; only ${WIRED_SHAPE_CLASSES.join(", ")} is supported`,
      },
    };
  }
  if (!Array.isArray(rawNames) || rawNames.some((name) => typeof name !== "string" || name.trim() === "")) {
    return { error: { path: classPath, kind: "invalid_value", message: `${classPath} must be a list of non-empty method names` } };
  }
  return { names: rawNames as readonly string[] };
};

/** 语言键校验：合法 id + **已接线族**白名单（未接线的族只改身份不改判断，必须拒绝）。 */
const languageKeyError = (language: string, path: string): LanguageShapeError | undefined => {
  if (!LANGUAGE_KEY.test(language)) {
    return { path, kind: "invalid_language_key", message: `${path} is not a valid language id` };
  }
  if ((WIRED_SHAPE_LANGUAGES as readonly string[]).includes(language)) return undefined;
  const hint = SHAPE_LANGUAGE_HINTS[language];
  return {
    path,
    kind: "not_wired",
    message: `${path} is not yet wired in this version: declaring it would change baseline identity without changing judgement; wired languages are ${WIRED_SHAPE_LANGUAGES.join(", ")}${hint ? ` (${hint})` : ""}`,
  };
};

/** 单个语言键的解析：返回该语言的形状（可空）与该语言的错误。 */
const parseLanguageEntry = (
  language: string,
  rawLanguageShapes: unknown,
): { readonly shapes?: LanguageShapes; readonly errors: readonly LanguageShapeError[] } => {
  const path = `shapes.${language}`;
  const keyError = languageKeyError(language, path);
  if (keyError) return { errors: [keyError] };
  if (!isPlainMapping(rawLanguageShapes)) {
    return { errors: [{ path, kind: "invalid_value", message: `${path} must be a mapping of shape class to value` }] };
  }
  const names: string[] = [];
  const errors: LanguageShapeError[] = [];
  for (const [shapeClass, rawNames] of Object.entries(rawLanguageShapes)) {
    const parsed = parseShapeClass(`${path}.${shapeClass}`, shapeClass, rawNames);
    if (parsed.error) errors.push(parsed.error);
    else names.push(...parsed.names!);
  }
  return names.length > 0 ? { shapes: { weakAssertionMethods: names }, errors } : { errors };
};

/**
 * `shapes` 配置值的**严格**解析/校验（唯一权威）——纯函数，无 IO。
 *
 * 返回 `{ shapes, errors }`：`errors` 非空时调用方**不得**使用 `shapes` 做判断
 * （fail-closed：一份半合法的声明既不能当"已声明"也不能当"未声明"）。
 * 合法但为空的 `shapes: {}` 不算错误，指纹为空、来源为内置。
 */
export const parseLanguageShapes = (value: unknown): { readonly shapes: ProjectShapes; readonly errors: readonly LanguageShapeError[] } => {
  if (value === undefined) return { shapes: {}, errors: [] };
  if (!isPlainMapping(value)) {
    return { shapes: {}, errors: [{ path: "shapes", kind: "invalid_value", message: "shapes must be a mapping of language to language shapes" }] };
  }
  const shapes: Record<string, LanguageShapes> = {};
  const errors: LanguageShapeError[] = [];
  for (const [language, rawLanguageShapes] of Object.entries(value)) {
    const parsed = parseLanguageEntry(language, rawLanguageShapes);
    errors.push(...parsed.errors);
    if (parsed.shapes) shapes[language] = parsed.shapes;
  }
  return { shapes, errors };
};

/**
 * 形状指纹（身份）——**确定性**：语言排序、每类名单排序后拼接。
 *
 * 为什么是"排序后拼接"而不是原样 JSON：配置里的键顺序是**书写顺序**（YAML 映射无序），
 * 让它进身份会让"调整书写顺序"凭空失效一份 baseline。空声明 ⇒ `""`
 * （与"记录里没有该字段"同一语义 ⇒ 默认零迁移）。
 *
 * 格式：`<language>:<class>:<name>,<name>;<language>:...`（无声明 ⇒ `""`）。
 */
export const shapesFingerprintOf = (shapes: ProjectShapes): string =>
  Object.keys(shapes).sort()
    .map((language) => {
      const declared = shapes[language];
      if (declared === undefined) return undefined;
      const names = [...new Set(declared.weakAssertionMethods)].sort();
      return names.length === 0 ? undefined : `${language}:weak_assertion_methods:${names.join(",")}`;
    })
    .filter((entry): entry is string => entry !== undefined)
    .join(";");

/** 声明了任何形状 ⇒ `project`；否则 `builtin`（报告必须披露这一位，§6/Q1）。 */
export const shapesSourceOf = (fingerprint: string): ShapesSource => fingerprint === "" ? "builtin" : "project";
