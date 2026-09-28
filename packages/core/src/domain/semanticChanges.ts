import type { FileAst, SemanticDeclaration } from "./ast";
import type { ChangeKind } from "./weights";

export interface SemanticChange {
  readonly anchor: string;
  readonly kind: ChangeKind;
}

/**
 * 声明身份歧义（fail-closed）：即使按最细身份（含完整签名）也无法唯一命名某个声明。
 * 携带冲突事实，使 CLI 能打印 `- <path>: <reason>` 而不是一句常量。
 */
export interface SemanticDeclarationAmbiguity {
  readonly id: string;
  /** 参与冲突的竞争签名（去重、排序），失败时至少两个。 */
  readonly signatures: readonly string[];
  /** 按该声明所属修订推断的变更类别；before/after 都有同类声明时为 `public_method_sig`。 */
  readonly suggestedKind: ChangeKind;
}

export type SemanticChangeAnalysis =
  | { readonly availability: "available"; readonly changes: readonly SemanticChange[] }
  | {
    readonly availability: "unavailable";
    readonly changes: readonly [];
    readonly reason: string;
    readonly ambiguity?: SemanticDeclarationAmbiguity;
  };

const same = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** TypeScript and similar languages may legally expose a type and value with one name. */
const declarationKey = (declaration: SemanticDeclaration): string => `${declaration.id}\u0000${declaration.kind}`;

interface QuoteState {
  /** 当前所在字面量的引号字符；undefined = 不在字面量内。 */
  readonly quote: string | undefined;
  /** 字面量内上一个字符是尚未消费的反斜杠转义。 */
  readonly escaped: boolean;
}

const isQuoteCharacter = (character: string): boolean => character === "\"" || character === "'";

/**
 * 引号/转义状态机的**唯一步进**（括号扫描与逗号统计共用同一判据，不再各写一份）：
 * 转义字符只在字面量内生效，被转义的引号不结束字面量。
 */
const stepQuote = (state: QuoteState, character: string): QuoteState => {
  if (state.escaped) return { quote: state.quote, escaped: false };
  if (character === "\\") return { quote: state.quote, escaped: true };
  return character === state.quote ? { quote: undefined, escaped: false } : state;
};

interface GroupState extends QuoteState {
  /** 自候选 `(` 起算的括号深度；回到 0 的位置即配对位置。 */
  readonly depth: number;
  /** 配对位置的下标；-1 = 尚未配对（含引号未闭合）。 */
  readonly closing: number;
  /** 组内深度 1 处出现过第二个 `(` ⇒ 该候选组不是参数表。 */
  readonly nested: boolean;
}

/** 候选组一旦配对完成就冻结，等价于原实现的 `break`：其后的字符不再影响结论。 */
const stepGroup = (state: GroupState, character: string, index: number): GroupState => {
  if (state.closing >= 0) return state;
  if (state.quote !== undefined) return { ...state, ...stepQuote(state, character) };
  if (isQuoteCharacter(character)) return { ...state, quote: character };
  if (character === "(") return { ...state, depth: state.depth + 1, nested: (state.nested || state.depth > 0) };
  if (character !== ")") return state;
  const depth = state.depth - 1;
  return depth > 0 ? { ...state, depth } : { ...state, depth, closing: index };
};

const scanParameterGroup = (signature: string, start: number): GroupState => {
  let state: GroupState = { quote: undefined, escaped: false, depth: 0, closing: -1, nested: false };
  for (let index = start; index < signature.length; index++) state = stepGroup(state, signature[index]!, index);
  return state;
};

/**
 * 定位**参数表文本**：从左到右试每一个 `(`，第一个“成功配对且组内深度 1 处没有第二个 `(`”
 * 的候选组即参数表（去掉首尾空白）；没有任何可接受的候选组时返回 undefined（不猜）。
 */
const findParameterList = (signature: string): string | undefined => {
  for (let start = 0; start < signature.length; start++) {
    if (signature[start] !== "(") continue;
    const group = scanParameterGroup(signature, start);
    if (group.closing < 0 || group.nested) continue;
    return signature.slice(start + 1, group.closing).trim();
  }
  return undefined;
};

const OPENING_BRACKETS = new Set(["(", "<", "[", "{"]);
const CLOSING_BRACKETS = new Set([")", ">", "]", "}"]);

/** 嵌套层级增量：参数表内 `()<>[]{}` 的任一开合对都算一层。 */
const levelDelta = (character: string): number => {
  if (OPENING_BRACKETS.has(character)) return 1;
  if (CLOSING_BRACKETS.has(character)) return -1;
  return 0;
};

interface CountState extends QuoteState {
  /** 已进入的嵌套层级；只有 level === 0 的逗号算顶层分隔符。 */
  readonly level: number;
  /** 顶层逗号个数。 */
  readonly commas: number;
}

const stepParameterCount = (state: CountState, character: string): CountState => {
  if (state.quote !== undefined) return { ...state, ...stepQuote(state, character) };
  if (isQuoteCharacter(character)) return { ...state, quote: character };
  if (character === "," && state.level === 0) return { ...state, commas: state.commas + 1 };
  return { ...state, level: state.level + levelDelta(character) };
};

/**
 * 数参数表内的顶层逗号：忽略引号/转义内的逗号，`()<>[]{}` 嵌套内的逗号不计。
 * 逗号数 + 1 即元数；空参数表（去空白后为空）是 0 个参数。
 * 这是**纯语法计数**，不做参数语法校验（`f(,)` 也记 2）——行为由特征矩阵钉住。
 */
const countTopLevelParameters = (parameters: string): number => {
  if (parameters.length === 0) return 0;
  let state: CountState = { quote: undefined, escaped: false, level: 0, commas: 0 };
  for (const character of parameters) state = stepParameterCount(state, character);
  return state.commas + 1;
};

/**
 * 取签名的参数个数；无法证明是参数列表时返回 undefined（**不猜**——猜 0 会把
 * “无参数列表的表达式”与真正的零参声明折叠成同一个身份）。
 *
 * 判定规则：**第一个可接受**的括号组（能配对，且组内深度 1 处没有第二个 `(`）——
 * `fill(int a, int b)` 是参数列表；`max(1, 2).size` 的第一个 `(` 组同样**可接受** ⇒ 返回 2
 * （启发式**不区分声明与调用表达式**，以实测为准，特征矩阵已逐例钉住）。此处此前写作
 * "`max(1, 2).size` …会被跳过并继续找下一个候选"，与实测不符，已按实测更正（**行为未改**）。
 * 分组深度忽略字符串与字符字面量中的括号。
 *
 * 结构（校准 2026-09-25，行为逐例钉在 `__tests__/domain/semanticChangesParameterArity.test.ts`）：
 * 原先一个字符级扫描器同时做三件事（找参数表 / 处理引号转义 / 统计顶层逗号），
 * local 控制复杂度 17.2 超过 domain 阈值 5。现按状态机拆开，每个函数的加权分支都 ≤ 5：
 * `findParameterList` 定位参数表区间，`countTopLevelParameters` 数顶层逗号，
 * `stepQuote` 是引号/转义的唯一判据（两处扫描共用，避免平行实现）。
 */
export const parameterArity = (signature: string): number | undefined => {
  const parameters = findParameterList(signature);
  if (parameters === undefined) return undefined;
  return countTopLevelParameters(parameters);
};

/**
 * 身份键的**唯一权威入口**：签名完全相同的声明是同一声明（解析器可能重复上报）；
 * 只有**跨修订**才谈"谁对应谁"，且只在无法证明时 fail-closed。判定见 `alignGroup`。
 */
const dedupeBySignature = (declarations: readonly SemanticDeclaration[]): readonly SemanticDeclaration[] => {
  const bySignature = new Map<string, SemanticDeclaration>();
  for (const declaration of declarations) {
    if (!bySignature.has(declaration.signature)) bySignature.set(declaration.signature, declaration);
  }
  return [...bySignature.values()];
};

const groupByBase = (declarations: readonly SemanticDeclaration[]): ReadonlyMap<string, readonly SemanticDeclaration[]> => {
  const groups = new Map<string, SemanticDeclaration[]>();
  for (const declaration of declarations) {
    const base = declarationKey(declaration);
    const bucket = groups.get(base);
    if (bucket) bucket.push(declaration);
    else groups.set(base, [declaration]);
  }
  return groups;
};

export interface DeclarationIdentity {
  /** 对齐后的 before 身份键 → 声明。 */
  readonly before: ReadonlyMap<string, SemanticDeclaration>;
  /** 对齐后的 after 身份键 → 声明；与 before 键相等 ⟺ 同一声明。 */
  readonly after: ReadonlyMap<string, SemanticDeclaration>;
  /** 无法对齐的基础身份（真正歧义）；调用方必须 fail-closed。 */
  readonly unresolved: readonly string[];
}

interface DeclarationPairing {
  readonly before: Map<string, SemanticDeclaration>;
  readonly after: Map<string, SemanticDeclaration>;
}

const put = (target: Map<string, SemanticDeclaration>, key: string, declaration: SemanticDeclaration): void => {
  if (!target.has(key)) target.set(key, declaration);
};

/**
 * 一个 (id, kind) 分组的跨修订配对。**判定顺序即安全边界**（校准 2026-09-25，B1/N9）：
 *
 * 1. 先按**完整签名**配对。签名相同 ⇒ 同一声明（体或可见性变化由此后的对比负责）。
 * 2. 若某一侧没有剩余（其签名集合被另一侧包含）⇒ 差集是**纯新增/纯删除**。
 *    这正是"含重载方法的文件"不再永久无法分类的地方：`{fill(int)}` → `{fill(int), fill(long)}`
 *    是"新增一个重载"，而不是歧义；同侧签名完全相同的重复上报也已在上一步折叠。
 * 3. 若两侧**各剩一个** ⇒ 沿用改造前的 `(id, kind)` 配对：它是"同一声明改了参数类型/签名/字段类型"，
 *    不是重载歧义。**这条必须保留**——否则"函数加一个参数""字段换类型"这类最常见的变更会退化成
 *    需要人工 override，正是本次要修的缺陷（也保证非重载文件的行为与 0.1.5 完全一致）。
 * 4. 其余情况（重载集合里同元数多签名被改写、单侧剩多个……）语法本身无法指出谁对应谁
 *    ⇒ 返回 undefined，调用方 fail-closed 并把竞争签名点名出来，绝不按位置猜。
 */
const alignGroup = (
  base: string,
  beforeGroup: readonly SemanticDeclaration[],
  afterGroup: readonly SemanticDeclaration[],
): DeclarationPairing | undefined => {
  const beforeDistinct = dedupeBySignature(beforeGroup);
  const afterDistinct = dedupeBySignature(afterGroup);
  const afterBySignature = new Map(afterDistinct.map((declaration) => [declaration.signature, declaration] as const));
  const beforeSignatures = new Set(beforeDistinct.map((declaration) => declaration.signature));
  const before = new Map<string, SemanticDeclaration>();
  const after = new Map<string, SemanticDeclaration>();
  // 1. 同签名配对：键里带签名，使"对齐后的键相等 ⟺ 同一声明"在两侧同时成立。
  for (const declaration of beforeDistinct) {
    const counterpart = afterBySignature.get(declaration.signature);
    if (!counterpart) continue;
    put(before, `${base}\u0000${declaration.signature}`, declaration);
    put(after, `${base}\u0000${counterpart.signature}`, counterpart);
  }
  const onlyBefore = beforeDistinct.filter((declaration) => !afterBySignature.has(declaration.signature));
  const onlyAfter = afterDistinct.filter((declaration) => !beforeSignatures.has(declaration.signature));
  if (onlyBefore.length === 0 && onlyAfter.length === 0) return { before, after };
  // 2. 单侧被包含 ⇒ 纯新增/纯删除。
  if (onlyBefore.length === 0 || onlyAfter.length === 0) {
    for (const declaration of onlyBefore) put(before, declarationKey(declaration), declaration);
    for (const declaration of onlyAfter) put(after, declarationKey(declaration), declaration);
    return { before, after };
  }
  // 3. 两侧各剩一个 ⇒ 旧行为（同一声明改了签名）。
  const [beforeOnly] = onlyBefore;
  const [afterOnly] = onlyAfter;
  if (onlyBefore.length === 1 && onlyAfter.length === 1) {
    put(before, declarationKey(beforeOnly!), beforeOnly!);
    put(after, declarationKey(afterOnly!), afterOnly!);
    return { before, after };
  }
  // 4. 无法证明配对 ⇒ fail-closed（由调用方点名冲突签名）。
  return undefined;
};

/**
 * 跨修订身份对齐。这是**唯一权威**的声明身份入口：
 * 逐 (id, kind) 分组后调用 `alignDeclarations`，只有无法配对的组才记入 `unresolved`。
 */
export const declarationIdentity = (
  before: readonly SemanticDeclaration[],
  after: readonly SemanticDeclaration[],
): DeclarationIdentity => {
  const beforeGroups = groupByBase(before);
  const afterGroups = groupByBase(after);
  const beforeKeys = new Map<string, SemanticDeclaration>();
  const afterKeys = new Map<string, SemanticDeclaration>();
  const unresolved: string[] = [];
  for (const base of new Set([...beforeGroups.keys(), ...afterGroups.keys()])) {
    const aligned = alignGroup(base, beforeGroups.get(base) ?? [], afterGroups.get(base) ?? []);
    if (!aligned) { unresolved.push(base); continue; }
    for (const [key, declaration] of aligned.before) if (!beforeKeys.has(key)) beforeKeys.set(key, declaration);
    for (const [key, declaration] of aligned.after) if (!afterKeys.has(key)) afterKeys.set(key, declaration);
  }
  return { before: beforeKeys, after: afterKeys, unresolved };
};

const declarationKind = (declaration: SemanticDeclaration, operation: "add" | "remove"): ChangeKind => {
  if (!declaration.isPublic) return declaration.kind === "function" ? "function_sig" : "function_body";
  if (operation === "add" && declaration.contractCompatibility === "additive") return "compatible_field_add";
  if (declaration.kind === "interface") return "interface_add_remove";
  if (declaration.kind === "class") return "class_add_remove";
  if (declaration.kind === "field") return "field_add_remove";
  return "public_method_sig";
};

const signatureKind = (before: SemanticDeclaration, after: SemanticDeclaration): ChangeKind => {
  const isPublic = before.isPublic || after.isPublic;
  if (!isPublic) return before.kind === "function" || after.kind === "function" ? "function_sig" : "function_body";
  if (before.kind === "interface" || after.kind === "interface") return "interface_add_remove";
  if (before.kind === "class" || after.kind === "class") return "class_add_remove";
  if (before.kind === "field" || after.kind === "field") return "field_add_remove";
  return "public_method_sig";
};

/**
 * 命名仍然冲突的声明：在 `unresolved` 里取基础身份最小的一组，列出全部竞争签名与建议类别。
 * 建议类别只依据冲突声明落在哪个修订（before/after 都有 ⇒ 修改；只在一侧 ⇒ 增/删）。
 */
const ambiguityOf = (
  before: readonly SemanticDeclaration[],
  after: readonly SemanticDeclaration[],
  unresolved: readonly string[],
): SemanticDeclarationAmbiguity | undefined => {
  const base = [...unresolved].sort()[0];
  if (!base) return undefined;
  const declarations = [...before, ...after].filter((declaration) => declarationKey(declaration) === base);
  if (declarations.length === 0) return undefined;
  const inBefore = before.some((declaration) => declarationKey(declaration) === base);
  const inAfter = after.some((declaration) => declarationKey(declaration) === base);
  return {
    id: declarations[0]!.id,
    signatures: [...new Set(declarations.map((declaration) => declaration.signature))].sort(),
    suggestedKind: inBefore && inAfter ? "public_method_sig" : declarationKind(declarations[0]!, inBefore ? "remove" : "add"),
  };
};

const hasAncestor = (declaration: SemanticDeclaration, candidates: ReadonlySet<string>): boolean => {
  const id = declaration.id;
  const segments = id.split(".");
  while (segments.length > 1) {
    segments.pop();
    const ancestor = segments.join(".");
    if ([...candidates].some((candidate) => candidate.startsWith(`${ancestor}\u0000`))) return true;
  }
  return false;
};

const importSources = (ast: FileAst): readonly string[] => [...new Set(ast.imports.map((entry) => entry.source))].sort();

interface DeclarationMaps {
  /** 身份对齐后的 before/after 视图；键相等 ⟺ 同一声明。 */
  readonly before: ReadonlyMap<string, SemanticDeclaration>;
  readonly after: ReadonlyMap<string, SemanticDeclaration>;
  /** True when the parser reports changed top-level syntax that has no declaration classifier. */
  readonly unsupportedTopLevelChanged: boolean;
}

const byUniqueId = (declarations: Iterable<SemanticDeclaration>): ReadonlyMap<string, SemanticDeclaration | undefined> => {
  const result = new Map<string, SemanticDeclaration | undefined>();
  for (const declaration of declarations) {
    if (result.has(declaration.id)) result.set(declaration.id, undefined);
    else result.set(declaration.id, declaration);
  }
  return result;
};

/** A stable exported name can move from a local definition to a re-export. */
const normalizeReexportIdentity = (
  declarations: Iterable<SemanticDeclaration>,
  counterparts: ReadonlyMap<string, SemanticDeclaration | undefined>,
): readonly SemanticDeclaration[] => [...declarations].map((declaration) => {
  const counterpart = counterparts.get(declaration.id);
  return declaration.provenance === "reexport" && counterpart
    ? { ...declaration, kind: counterpart.kind, signature: counterpart.signature, ...(counterpart.body ? { body: counterpart.body } : {}) }
    : declaration;
});

const mapsFor = (before: FileAst | undefined, after: FileAst | undefined): DeclarationMaps | SemanticChangeAnalysis => {
  if (!before && !after) return { availability: "unavailable", changes: [], reason: "revision has no readable source" };
  const beforeSurface = before?.semanticSurface;
  const afterSurface = after?.semanticSurface;
  if ((before && !beforeSurface) || (after && !afterSurface)) {
    return { availability: "unavailable", changes: [], reason: "language parser does not provide declaration facts" };
  }
  const rawBefore = beforeSurface?.declarations ?? [];
  const rawAfter = afterSurface?.declarations ?? [];
  const beforeDeclarations = normalizeReexportIdentity(rawBefore, byUniqueId(rawAfter));
  const afterDeclarations = normalizeReexportIdentity(rawAfter, byUniqueId(rawBefore));
  const identity = declarationIdentity(beforeDeclarations, afterDeclarations);
  if (identity.unresolved.length > 0) {
    const ambiguity = ambiguityOf(beforeDeclarations, afterDeclarations, identity.unresolved);
    const reason = ambiguity
      ? `declaration identities are ambiguous: ${ambiguity.id} has ${ambiguity.signatures.length} competing signatures (${ambiguity.signatures.join(" | ")})`
      : "declaration identities are ambiguous";
    return { availability: "unavailable", changes: [], reason, ...(ambiguity ? { ambiguity } : {}) };
  }
  return {
    before: identity.before,
    after: identity.after,
    unsupportedTopLevelChanged: !!(beforeSurface && afterSurface && !same(beforeSurface.unsupportedTopLevel, afterSurface.unsupportedTopLevel)),
  };
};

/**
 * 新增/删除判定：身份对齐后只在单侧存在的键就是新增/删除。
 * 因为对齐层是“两侧共同可用”的，键相等 ⟺ 同一声明，所以这里不需要再做任何抵消：
 * 同一声明不可能在另一侧缺少自己的键。
 */
const addedOrRemovedChanges = (
  declarations: ReadonlyMap<string, SemanticDeclaration>,
  missingFrom: ReadonlyMap<string, SemanticDeclaration>,
  operation: "add" | "remove",
): readonly SemanticChange[] => {
  const changed = [...declarations].filter(([key]) => !missingFrom.has(key));
  const candidates = new Set(changed.map(([, declaration]) => declarationKey(declaration)));
  return changed.flatMap(([, declaration]) =>
    hasAncestor(declaration, candidates) ? [] : [{ anchor: declaration.id, kind: declarationKind(declaration, operation) }]
  );
};

const changedDeclarationUnits = (before: ReadonlyMap<string, SemanticDeclaration>, after: ReadonlyMap<string, SemanticDeclaration>): readonly SemanticChange[] =>
  [...before].flatMap(([key, beforeDeclaration]) => {
    const afterDeclaration = after.get(key);
    if (!afterDeclaration) return [];
    if (beforeDeclaration.kind !== afterDeclaration.kind || beforeDeclaration.signature !== afterDeclaration.signature || beforeDeclaration.isPublic !== afterDeclaration.isPublic) {
      return [{ anchor: beforeDeclaration.id, kind: signatureKind(beforeDeclaration, afterDeclaration) }];
    }
    return beforeDeclaration.kind === "function" && beforeDeclaration.body !== afterDeclaration.body
      ? [{ anchor: beforeDeclaration.id, kind: "function_body" }]
      : [];
  });

const importChanges = (before: FileAst | undefined, after: FileAst | undefined): readonly SemanticChange[] => {
  const beforeImports = new Set(before ? importSources(before) : []);
  const afterImports = new Set(after ? importSources(after) : []);
  return [
    ...[...afterImports].filter((source) => !beforeImports.has(source)).map((source) => ({ anchor: `import:${source}`, kind: "dependency_add" as const })),
    ...[...beforeImports].filter((source) => !afterImports.has(source)).map((source) => ({ anchor: `import:${source}`, kind: "dependency_remove" as const })),
  ];
};

/**
 * Pure, conservative declaration-level change classifier. It only falls back
 * to `function_body` for changed top-level syntax when there are no other
 * declaration/import units to classify; it never invents public contract
 * changes from unclassified syntax.
 */
export const analyzeSemanticChanges = (before: FileAst | undefined, after: FileAst | undefined): SemanticChangeAnalysis => {
  const maps = mapsFor(before, after);
  if ("availability" in maps) return maps;
  const changes = [
    ...addedOrRemovedChanges(maps.after, maps.before, "add"),
    ...addedOrRemovedChanges(maps.before, maps.after, "remove"),
    ...changedDeclarationUnits(maps.before, maps.after),
    ...importChanges(before, after),
  ];
  if (changes.length > 0) return { availability: "available", changes };
  if (maps.unsupportedTopLevelChanged) {
    return { availability: "available", changes: [{ anchor: "file:top-level", kind: "function_body" }] };
  }
  return { availability: "available", changes: [{ anchor: "file", kind: "comment_whitespace" }] };
};
