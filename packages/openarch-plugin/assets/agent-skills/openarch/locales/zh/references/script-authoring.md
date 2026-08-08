# 项目脚本编写合同

> “从群众中来，到群众中去。”——《关于领导方法的若干问题》

新建、修改或审查隐式依赖、反模式、测试 finding 脚本前完整阅读本页。这里只描述发行版公开扩展点；不要为某个接入项目改 parser、语言注册、WASM grammar、内部 storage 或 CLI。

## 选择事实与骨架

先把要治理的主张写成可验证事实，再选择最小边界：

| 需要证明的事实 | 先运行 |
|---|---|
| 单文件 AST 结构 | `openarch rules skeleton staged-ast` |
| 已分类文件或路径角色 | `openarch rules skeleton classification` |
| 已有结构度量 | `openarch rules skeleton metrics` |
| authority 内静态导入越界 | `openarch rules skeleton authority-import` |
| 有界 Git 变更集中的 authority 越界 | `openarch rules skeleton authority-change-set` |

先运行 `openarch rules facts` 确认项目语言和发行版事实能力。`skeleton` 只输出，不写入项目；以它为起点在 `.openarch` 编写脚本。不得凭记忆猜测 Tree-sitter 节点名，或复制另一种语言的 query；同一模式可以有各自语言实现和合法边界。

依赖设计意图、运行时行为、广泛类型或数据流、业务语义或昂贵全程序分析的问题，不能伪装为静态脚本。用 `review` 和局部调查记录事实、假设和未知，必要时记录 `Debt`。

## 固定执行模型

文件或仓库规则导出一个 `default` 对象，并遵循引擎顺序：

```js
export default {
  scope: "file",
  targets: { fileKinds: ["production"] },
  requires: ["file-classification.v1"],
  stages: {
    text: ({ files, text }) => files.filter((file) => text(file).includes("candidate")),
    ast: { pattern: "(identifier) @name", extract: (matches) => matches.map(() => ({})) },
  },
  link: ({ records, facts }) => [],
};
```

`text -> ast -> link` 是固定顺序：`text` 只做候选剪枝，`ast` 只处理候选，`link` 只消费 records。不要自行遍历项目、发起 query、读取 Git、配置或 baseline、计算指标，或安排脚本顺序。可复用派生信息应先成为 runtime 事实，不能通过脚本顺序或跨脚本全局状态传递。

变更集规则只导出 `scope: "change_set"`、所需 `requires`、可选 `staticImports` 和 `detect`。它只能消费引擎提供的有界 `changeSet` 与 `facts`，不能自行调用 Git 或扫描仓库。

## 变更面、全量候选与路径边界

变更面是**补充事实**，不是脚本主线：默认脚本行为不因变更面存在而改变。变更模式（`rules discover --worktree/--staged`）下 `files` 仍只含变更文件（默认聚焦）；需要全量 records × 变更面交叉的脚本（如消费者模式）在 `text` 阶段显式取 `allFiles` 补充全量候选，非变更模式 `allFiles` 未注入时回退 `files`：

```js
text: ({ files, allFiles }) => allFiles ?? files,
```

`ast.extract` 的第三参数 `change`（`AstChangeContext`）在变更模式注入：`changedLines`（1 起的变更行号，after）与 `hunks`（含语义容器 `container:{name,kind}`）。只关心变更部分的脚本按行聚焦：`matches.filter((m) => change.changedLines.has(m.startLine))`。

引擎路径边界统一为**仓库相对路径**：`text` 入参（`files`/`allFiles`）、`records[]._file`（含 static-imports 分支）与 `targetFiles` 全部经 `normalizeRepositoryPath` 归一化——多人协作 checkout 位置不确定，绝对路径会让 records/落盘/缓存随机器漂移；脚本不得自行再相对化或依赖绝对路径。`change-surface.v1`（可选事实，非 `requires` 必需）在变更模式注入 `changedSymbols`（file/anchor/kind）与 `changes`（hunk 级 before/after 片段 + 起始行 + 容器）；非变更模式 `availability` 为 `unavailable`，脚本应降级为全量发现而不是报错。

## 可用事实与边界

`requires` 只声明实际需要的能力：`file-classification.v1` 提供规范化路径、`fileKind`、`pathClass`；`structure-metrics.v1` 提供兼容 `baseline` 的原始结构与图事实；`authorities.v1` 提供显式 `authority`、受保护文件和禁止导入；`test-case-spans.v1` 提供 `provider` 确认的测试体范围；`invocation-bindings.v1` 提供 `parser` 确认的本地 `receiver` 或 `alias binding`。

这些能力不允许推断目录意图、层权重、`P95`、`CRL`、`I_push`、门禁、阈值、owner、对象流或动态派发。`PARTIAL` 和 `UNAVAILABLE` 不是零；依赖事实不完整时，规则必须保持不可用，不得以空 finding 通过。

## 文件选择、authority 与输出

用 `targets` 声明 `languages`、`include`、`exclude`、`fileKinds`、`pathClasses` 或 `authority`。语言专项脚本必须声明 `languages`；引擎通过共享语言注册表先筛选，再执行 text/AST，不要只靠扩展名 glob 假定语言。glob 按项目根相对 POSIX 路径解释；不要手写路径归一化、`startsWith` 或目录成员判断。可复用 authority 放配置；仅此规则需要的 authority 可写在规则顶层，由引擎派生 `protectedFiles` 与 `authorityIds`。不要从类名、文件名、项目目录或 import 反推 authority。

静态导入边界使用 `authority-import` skeleton 与 `static-imports.v1`；不要为不同语言重新匹配 import AST 或用 regex 解析源码。动态导入、未解析语法和不支持语言必须保持 `UNAVAILABLE`。

`finding` 至少包含 `ruleId`、`file`、`message`。行号只能来自直接保留的 `parser capture` `line` 或 `endLine`，不得用文本搜索猜测。默认 `finding` 仅报告，不进入门禁、`CRL` 或 `I_push`。

## 校准闭环

1. 保存修复前 observation，并定义违规、合法替代和 `UNAVAILABLE` fixture。
2. 编写规则，运行 `openarch rules check`，再用 `openarch rules scan` 或 `openarch rules discover` 回扫，确认它能命中存量。
3. 修复存量，重新回扫确认 `CLEAN`；保留修复前 observation、历史 revision 或真实回归 fixture 作为正例。
4. 仅当项目具备充分 authority、正例与 fixture 证据时，才在既有 `quality_rules` 中选择 `warn` 或 `block`，并用 `openarch rules scan --check` 验证。

没有存量命中不会自动失败：已有正例时是 `CLEAN`，没有正例时是 `UNVALIDATED`。不得把仅报告 finding 直接接入门禁或公式。

需要调查直接类/接口关系时，脚本可声明 `requires: ["semantic-relations.v1"]`，再从 `facts.semanticRelations.value.relations` 消费提供方已证明的关系。该事实只含直接 `extends`、`implements`、显式类型和构造边，且带语言、提供方、覆盖范围与证据；不能将其当成完整调用图、传递依赖或运行时对象流。不要在脚本内启动 `LSP`、建立编译器项目或重扫工作区：没有完整提供方覆盖时，让规则保持 `UNAVAILABLE/PARTIAL`。
