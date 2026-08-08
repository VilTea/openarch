// 通用指标渲染（数学美）：公式行 + 对齐表格。
// 对齐基于显示宽度（CJK 字符按 2 列计算），数值列右对齐，可选 mark 列
// （如 TEST_BLOAT 的 `*` 触发标记）。渲染层只做展示，不做指标计算。

export interface TableColumn {
  readonly header: string;
  readonly align?: "left" | "right";
  /** 可选固定显示宽度；缺省取表头与所有行的最大宽度。 */
  readonly width?: number;
}

export interface TableRenderOptions {
  /** 每行首列前的标记（如 "* " 触发 / "  " 未触发）；传入则每个 row 需自带该前缀。 */
  readonly rowPrefix?: (rowIndex: number) => string;
  readonly indent?: string;
}

/** 显示宽度：CJK/全角字符按 2 列，其余按 1 列。 */
export const displayWidth = (text: string): number =>
  [...text].reduce((width, char) => width + ((char.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0);

const pad = (text: string, width: number, align: "left" | "right"): string => {
  const gap = Math.max(0, width - displayWidth(text));
  return align === "right" ? " ".repeat(gap) + text : text + " ".repeat(gap);
};

/**
 * 渲染对齐表格：每列取 max(header, cells, width?) 的显示宽度，
 * 数值列右对齐；返回不含首行缩进的完整行数组（表头 + 数据）。
 */
export const renderAlignedTable = (
  columns: readonly TableColumn[],
  rows: readonly (readonly string[])[],
  options: TableRenderOptions = {},
): readonly string[] => {
  const widths = columns.map((column, index) => {
    const headerWidth = displayWidth(column.header);
    const cellWidth = rows.reduce((max, row) => Math.max(max, displayWidth(row[index] ?? "")), 0);
    return Math.max(headerWidth, cellWidth, column.width ?? 0);
  });
  const indent = options.indent ?? "";
  const header = columns.map((column, index) => pad(column.header, widths[index]!, column.align ?? "left")).join(" ");
  const body = rows.map((row, index) => {
    const cells = columns.map((column, columnIndex) => pad(row[columnIndex] ?? "", widths[columnIndex]!, column.align ?? "left")).join(" ");
    const prefix = options.rowPrefix?.(index) ?? "";
    return prefix + cells;
  });
  return [indent + header, ...body.map((line) => indent + line)];
};

/** 公式行：`- 标题: formula = value mark`。mark 如 "* 已触发" 或 "（正常范围）"。 */
export const renderFormulaLine = (title: string, formula: string, value: string, mark = ""): string =>
  `- ${title}: ${formula} = ${value}${mark ? ` ${mark}` : ""}`;
