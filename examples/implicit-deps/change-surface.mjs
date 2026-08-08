// 变更面示例规则（change-surface.v1）：变更驱动的隐式依赖重扫
//
// 用法：openarch rules discover --worktree --rule examples/implicit-deps/change-surface.mjs
// （或 --staged）。变更模式下引擎从 git diff 构造变更集、聚焦变更文件，并向
// facts.changeSurface 注入：
//   - changedSymbols：变更的声明（file/anchor/kind/consumers）
//   - changes：文件内具体变更部分（hunk 级——变更行片段 + before/after 起始行
//     + 语义容器 container:{name,kind}——变更行归属的方法/类/函数）
//
// 变更时隐式依赖分析的典型用法（本示例展示三阶段各怎么用变更面）：
//
//   阶段一 text（选文件）：facts.changeSurface 可用时按变更文件过滤；变更面
//     不可用（非变更模式）时回退全量。引擎已预聚焦变更文件，这里展示的是
//     脚本自决的形态——例如按 container 过滤（只处理有变更方法的文件）。
//   阶段二 ast（提取记录）：extract 的第三参数 change 携带 changedLines（1 起
//     的变更行号）与 hunks——只提取变更行命中的 AST 节点，records 少而准，
//     天然聚焦"变更的部分"（本示例：只保留变更行的动态 import 调用）。
//   阶段三 link（汇总）：facts.changeSurface 全量可用——对比 before/after 判断
//     新增/删除的隐式引用边。
//
// 注：脚本引擎不接 LSP——它的定位正是发现 LSP 与通用静态分析无法捕捉的
// 隐式依赖（反射/动态 import 等）；预计算的消费者列表对脚本无意义。
//
// 本示例：扫描变更行的动态 import/require，输出 dynamic-import-change 边
// （from=变更文件，via=变更行片段 + 语义容器）。
export default {
  requires: ["change-surface.v1"],
  stages: {
    text: ({ files, facts }) => {
      // 脚本自决：变更面可用时聚焦变更文件（引擎已预聚焦，此处显式化）；
      // 不可用（非变更模式）回退全量。
      const surface = facts.changeSurface;
      if (surface?.availability === "available") {
        return files.filter((file) => surface.value.changes.some((c) => c.file === file));
      }
      return files;
    },
    ast: {
      // 动态 import / require 调用（TS/JS 通用查询）
      pattern: "(call_expression function: (identifier) @fn (#match? @fn \"^(import|require)$\")) @call",
      extract: (matches, file, change) => {
        const changed = change?.changedLines;
        return matches
          .filter((match) => !changed || match.startLine == null || changed.has(match.startLine))
          .map((match) => ({
            line: match.startLine,
            snippet: (match.captures[0]?.text ?? "").slice(0, 60).replace(/\s+/g, " "),
            container: changed ? undefined : undefined, // 容器信息经 facts 的 hunks 查询更完整
          }));
      },
    },
  },
  link: ({ facts, records }) => {
    const surface = facts.changeSurface;
    if (surface?.availability !== "available") {
      return [{
        from: ".",
        to: ".",
        via: `change-surface unavailable: ${surface?.reason ?? "unknown"}`,
        type: "change-surface-error",
      }];
    }
    const edges = [];
    // 阶段三（a）：变更的声明符号（changedSymbols——文件级锚定）
    for (const symbol of surface.value.changedSymbols) {
      edges.push({
        from: symbol.file,
        to: symbol.file,
        via: `changed:${symbol.anchor} (${symbol.kind})`,
        type: "change-surface.v1",
      });
    }
    // 阶段三（b）：hunk 级对比——after 新增动态引用 / before 删除动态引用
    const dynamicImportPattern = /import\(\s*[`'"]|require\(\s*[`'"]|import\(\s*[A-Za-z_$]/;
    for (const change of surface.value.changes) {
      for (const hunk of change.hunks) {
        const afterText = hunk.after.join("\n");
        const container = hunk.container ? `${hunk.container.kind}:${hunk.container.name}` : "file";
        if (dynamicImportPattern.test(afterText)) {
          const snippet = afterText.slice(0, 60).replace(/\s+/g, " ").trim();
          edges.push({
            from: change.file,
            to: change.file,
            via: `dynamic-import: ${snippet} (after:${hunk.afterStartLine}, ${container})`,
            type: "dynamic-import-change",
          });
        }
      }
    }
    // 阶段二记录兜底：ast 阶段命中的变更行（未被 hunk 模式覆盖时的补充）
    for (const record of records) {
      edges.push({
        from: record._file,
        to: record._file,
        via: `ast-hit:${record.line ?? "?"}:${record.snippet ?? ""}`.slice(0, 80),
        type: "dynamic-import-change-ast",
      });
    }
    return edges;
  },
};
