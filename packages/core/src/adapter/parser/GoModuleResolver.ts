import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ModuleResolver } from "./ModuleResolver";

interface GoModuleContext {
  readonly modulePath: string;
  readonly rootDir: string;
}

const moduleCache = new Map<string, GoModuleContext | null>();

/** go.mod 是 Go 自有格式（不是 TOML/YAML），仓库内没有可复用的解析能力，因此这里实现一个
 *  **单遍、有界**的扫描器，替代审计 C-5 指出的"用正则读整份 go.mod"：
 *  `module` 指令只在**已证明**的顶层、可证明的行结构上取值，证明不了就报不可用。
 *
 *  有界：只在文件前 `GO_MOD_SCAN_MAX_LINES` 行内解析。真实 go.mod 的 module 指令总在文件开头；
 *  若它落在界外，结果是"未解析（unavailable）"而不是"猜一个 module 路径"。 */
export const GO_MOD_SCAN_MAX_LINES = 512;

/** go.mod 扫描结果。`unprovable` 表示文件结构未能被证明（块注释、未闭合块、多余 `)`、
 *  重复/畸形 module 指令）——调用方必须当作不可用，而不是"没有依赖"。 */
export interface GoModScan {
  readonly modulePath: string | null;
  readonly unprovable: boolean;
}

/** go.mod 行注释：`//` 之后属于注释。module 路径本身不可能含 `//`（非法路径），因此按首个 `//` 截断可证明。 */
const stripLineComment = (line: string): string => {
  const at = line.indexOf("//");
  return at === -1 ? line : line.slice(0, at);
};

/** go.mod 的路径 token：裸 token、反引号原始字符串、或双引号 Go 字符串。
 *  出现本解析器不支持的转义时返回 null（不猜），由调用方 fail-closed。 */
const parseGoString = (token: string): string | null => {
  if (token.startsWith("`")) return token.length >= 2 && token.endsWith("`") ? token.slice(1, -1) : null;
  if (!token.startsWith("\"")) return token.includes("\"") ? null : token;
  if (token.length < 2 || !token.endsWith("\"")) return null;
  let value = "";
  for (let index = 1; index < token.length - 1; index += 1) {
    const char = token[index];
    if (char !== "\\") {
      value += char;
      continue;
    }
    const escaped = token[index + 1];
    if (escaped !== "\\" && escaped !== "\"") return null;
    value += escaped;
    index += 1;
  }
  return value;
};

/**
 * 单遍行扫描的**状态**：`blockDepth` 只统计 `directive (` … `)` 块深度；
 *  `modulePath` 一旦被证明就不再改写，`unprovable` 一旦置位就粘住。
 *
 *  行分类是扫描器的核心概念，因此显式命名（`GoModLine` 的行形态 + `classifyLine`），
 *  而不是把判据写成一串嵌套 `if`——校准 2026-09-26：原先全部集中在 `scanGoMod`（加权分支 8.9），
 *  本地负担 crl_local=0.450 触发了"核心模块局部负担偏高"。
 */
interface GoModScanState {
  readonly modulePath: string | null;
  readonly unprovable: boolean;
  readonly blockDepth: number;
}

const INITIAL_SCAN_STATE: GoModScanState = { modulePath: null, unprovable: false, blockDepth: 0 };
const unprovableState = (state: GoModScanState): GoModScanState => ({ ...state, unprovable: true });

/** `)` 只在已进入块时配平；孤立的多余 `)` 说明块结构不可证明。 */
const closeBlock = (state: GoModScanState): GoModScanState =>
  state.blockDepth === 0 ? unprovableState(state) : { ...state, blockDepth: state.blockDepth - 1 };

/** module 指令取值：路径必须能被证明、非空、且此前没有第二个 module 指令。 */
const readModulePath = (state: GoModScanState, rest: string): GoModScanState => {
  const path = parseGoString(rest);
  if (path === null || path.length === 0 || state.modulePath !== null) return unprovableState(state);
  return { ...state, modulePath: path };
};

/** 行形态：`ignore` 空行/注释、`block-comment` 块注释、`close-block` 的 `)`、
 *  `open-block` 的 `directive (`、顶层 `directive`、以及没有合法指令头的 `malformed`。
 *  畸形行是一种**行形态**，不再借指令槽位里的字符串哨兵来表达。 */
type GoModLineKind = "ignore" | "block-comment" | "close-block" | "open-block" | "directive" | "malformed";

interface GoModLine {
  readonly kind: GoModLineKind;
  /** 指令名；仅 `directive` / `open-block` 有值。 */
  readonly directive: string;
  /** 指令头之后的剩余文本；仅 `directive` 有值。 */
  readonly rest: string;
}

const IGNORED_LINE: GoModLine = { kind: "ignore", directive: "", rest: "" };
/** 块注释会跨行，行扫描无法证明其边界 ⇒ 整份文件报不可用。 */
const BLOCK_COMMENT_LINE: GoModLine = { kind: "block-comment", directive: "", rest: "" };
const CLOSE_BLOCK_LINE: GoModLine = { kind: "close-block", directive: "", rest: "" };
const MALFORMED_LINE: GoModLine = { kind: "malformed", directive: "", rest: "" };

/** 行头指令名：`module example.com/m` → `module`；`123 x` / `-x` 没有合法标识符 ⇒ 畸形行。 */
const DIRECTIVE_HEAD = /^([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/u;

const classifyLine = (line: string): GoModLine => {
  if (line.length === 0 || line.startsWith("//")) return IGNORED_LINE;
  if (line.includes("/*") || line.includes("*/")) return BLOCK_COMMENT_LINE;
  if (line === ")") return CLOSE_BLOCK_LINE;
  const head = DIRECTIVE_HEAD.exec(line);
  if (!head) return MALFORMED_LINE;
  const directive = head[1];
  const rest = head[2].trim();
  return rest === "(" ? { kind: "open-block", directive, rest: "" } : { kind: "directive", directive, rest };
};

/** 行处理：块内只认 `)`，其余内容（含嵌套 `directive (` 与畸形行）一律跳过，不参与判定；
 *  块外按行形态显式分支——块注释 / 多余 `)` / 畸形行 ⇒ 不可证明，`directive (` 开块，
 *  `module <path>` 是唯一取值形态，与 module 无关的指令（go/toolchain/require/…）跳过。
 *
 *  任何指令的块形式都跟踪：块内的 `module` 行不是顶层指令，不能被当成 module 声明。
 *  `module (` 本身也不是可证明的行形态，因此开块的同时就报不可用。 */
const stepScan = (state: GoModScanState, line: GoModLine): GoModScanState => {
  if (line.kind === "ignore") return state;
  if (line.kind === "block-comment") return unprovableState(state);
  if (line.kind === "close-block") return closeBlock(state);
  if (state.blockDepth > 0) return state;
  if (line.kind === "malformed") return unprovableState(state);
  if (line.kind === "open-block") return line.directive === "module" ? unprovableState(state) : { ...state, blockDepth: state.blockDepth + 1 };
  if (line.directive !== "module") return state;
  return readModulePath(state, line.rest);
};

/** 单遍行扫描：跟踪 `directive (` … `)` 块深度，只在顶层解析 module 指令。
 *  其余指令（go/toolchain/require/replace/exclude/retract/…）的内容与 module 行无关，
 *  只要能正确跳过（包括跳过整个块）即可，因此不做语义解析。 */
export const scanGoMod = (content: string): GoModScan => {
  const lines = content.split(/\r?\n/u).slice(0, GO_MOD_SCAN_MAX_LINES);
  let state = INITIAL_SCAN_STATE;
  for (const rawLine of lines) state = stepScan(state, classifyLine(stripLineComment(rawLine).trim()));
  if (state.blockDepth > 0) state = unprovableState(state);
  return { modulePath: state.modulePath, unprovable: state.unprovable };
};

const readModuleContext = (startDir: string): GoModuleContext | null => {
  if (moduleCache.has(startDir)) return moduleCache.get(startDir) ?? null;
  let current = resolve(startDir);
  while (true) {
    const goModPath = join(current, "go.mod");
    if (existsSync(goModPath)) return scanModuleContext(startDir, current, readFileSync(goModPath, "utf8"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // 不缓存 null：长驻进程中项目稍后新增 go.mod 时应重新解析成功。
  return null;
};

/** 只有 module 指令被证明时才建立上下文；否则保持"未解析"（ImportRef.resolvedPath = null），
 *  不猜、也不把不可用当成"没有依赖"。 */
const scanModuleContext = (startDir: string, current: string, content: string): GoModuleContext | null => {
  const scan = scanGoMod(content);
  const context = scan.modulePath !== null && !scan.unprovable ? { modulePath: scan.modulePath, rootDir: current } : null;
  moduleCache.set(startDir, context);
  return context;
};

/** 包目录内的非测试 Go 源文件（绝对路径、`/` 归一化、排序）。
 *  只收 `.go`、排除 `_test.go`；非 Go 文件不进列表，因此不会被归一化后混入。 */
const goSourceFilesIn = (packageDir: string): readonly string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(packageDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) {
      files.push(resolve(packageDir, entry.name).replace(/\\/g, "/"));
    }
  }
  return files.sort();
};

/** module 路径 ⇒ 包目录；不在模块内返回 null（调用方据此返回空列表，而不是"没有依赖"）。 */
const packageDirOf = (context: GoModuleContext, source: string): string | null => {
  if (source === context.modulePath) return context.rootDir;
  if (!source.startsWith(`${context.modulePath}/`)) return null;
  return resolve(context.rootDir, source.slice(context.modulePath.length + 1));
};

/** Resolves a Go module-local package to its non-test source files. */
export const goModuleResolver: ModuleResolver = {
  resolveLocal: (filePath, source) => {
    const context = readModuleContext(dirname(filePath));
    if (!context) return [];
    const packageDir = packageDirOf(context, source);
    if (packageDir === null || !existsSync(packageDir)) return [];
    return goSourceFilesIn(packageDir);
  },
};
