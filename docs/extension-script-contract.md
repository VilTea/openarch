# 扩展脚本合同

**状态**：当前实现合同。它规定发布版 OpenArch 为项目和 coding agent 提供的脚本扩展边界，不是 OpenArch 自身目录结构的约定。

## 目的

项目脚本可以发现本项目的局部事实，但不能各自复制源码遍历、AST 查询调度、导出兼容或策略裁决。否则同一类规则会在不同能力中逐步形成不同的性能边界、错误语义和迁移成本。

所有需要遍历项目源码的脚本遵守同一最小结构：

```js
export default {
  targets: { languages: ["typescript"], fileKinds: ["production"], include: ["src/**/*.ts"] },
  stages: {
    text: ({ files, text, facts }) => files.filter((file) => text(file).includes("candidate")),
    ast: { pattern: "(identifier) @name", extract: (matches) => matches.map(() => ({})) },
  },
  link: ({ records, log, facts }) => [],
};
```

`text` 和 `ast` 可选，但执行顺序固定为 `text -> AST -> link`：引擎只对 text 候选运行 AST 查询，`link` 只能接收引擎产生的 records。所有领域脚本收到同一只读、版本化 `facts` 快照；反模式 change-set 规则也通过 `detect({ changeSet, facts, log })` 使用它。模块只有一个公开入口 `export default`；不保留命名 `detect`、`rule` 或 `stages` 的兼容回退。

`ast` 有两种引擎拥有的实现：常规 `{ pattern, extract? }` 是脚本选择的 Tree-sitter query；`{ fact: "static-imports.v1" }` 则让 ParserStrategy 以当前语言的已注册语法解析 text 候选，并产生 `{ _file, source, language }` records。后者不把 `import_statement`、`use_declaration` 或其他语言节点名泄露给脚本，适用于 authority 的静态 import 边界。解析任一候选失败时规则为 `UNAVAILABLE`，不会以零 import 继续。change-set 规则可声明 `staticImports: true`；runtime 仅对有界 before/after 文本调用 `parseText`，向每个文件提供 `beforeStaticImports` 和 `afterStaticImports`。

`requires` 是可选的能力声明。要求的事实不是 `available` 时，引擎不执行 `link`/`detect`，而是报告 `UNAVAILABLE`；`PARTIAL` 也不能被当成完整快照。当前可用能力如下：

| capability | 提供事实 | 刻意不提供 |
|---|---|---|
| `file-classification.v1` | 规范化的仓库相对 POSIX 路径、语言范围内的 `fileKind` 与 `pathClass` | `paths` pattern、层权重或目录假设 |
| `structure-metrics.v1` | compatible baseline 的原始分支、嵌套、LOC、外部编排、直接图事实与 contract/scope 可用性 | P95、CRL/I_push、gate verdict、阈值和历史趋势 |
| `authorities.v1` | 项目可复用 authority，以及当前脚本私有声明的 owner、public entry、protected paths、引擎派生的 `protectedFiles` 与禁止操作 | 从路径、命名或 import 推导出的隐式 owner |
| `test-case-spans.v1` | 当前 test provider 确认的测试体文件、名称、行范围和状态 | 未识别框架、运行时注册、覆盖率或任意测试风格判断 |
| `invocation-bindings.v1` | 语言 provider 已确认的调用接收者、方法和局部绑定目标 | 全程序对象流、容器传播、动态属性、反射或未支持语言；这些情况必须 unavailable |
| `semantic-relations.v1` | provider 在受治理源码范围内直接证明的类/接口 `extends`、`implements`、显式类型与构造关系，以及每语言 coverage | 外部库/标准库、传递闭包、运行时调用/DI/反射、任意类依赖推断、指标、阈值或 gate；`complete` 只适用于 provider 声明的直接静态范围 |

事实由应用层每次命令组装一次，staged runtime 向反模式、隐式依赖和测试 finding 脚本注入同一快照。脚本不得读取 config/baseline 重算这些事实；这既避免平行分析引擎，也让事实缺失保持可观察。

测试脚本的执行拓扑固定为 `provider collection -> versioned facts -> scripts -> project policy`。脚本通过 `requires` 声明事实依赖；例如依赖 `test-case-spans.v1` 的规则只会在所有当前测试文件由 provider 完整处理后运行，未识别或采集失败时保持 `UNAVAILABLE/PARTIAL`。不支持脚本数字优先级、`before/after` 或脚本 finding 依赖，避免把执行顺序和派生分析重新分散到项目脚本；确有复用价值的新中间结果必须先成为 runtime 拥有的版本化事实。

## 声明式文件选择

每个 `StagedRule` 可选声明 `targets`，由引擎在 `text` 前统一选择文件：

```js
targets: {
  languages: ["typescript"],
  include: ["src/**/*.ts"],
  exclude: ["**/*.test.ts"],
  fileKinds: ["production"],
  pathClasses: ["application"],
  authority: ["shared-authority"], // 或 "any"
}
```

所有条件取交集；同一列表内的 pattern/authority 取并集。glob 按项目根相对 POSIX 路径匹配，绝对路径和含 `..` 的 pattern 会被拒绝。`languages` 由共享语言注册表按受支持源码扩展名选择，先于 text/AST 阶段执行；它与 `include` 可同时声明作为收敛且可读的双重边界，但脚本不能只靠 glob 假定语言。`fileKinds`/`pathClasses`/`languages` 自动要求 `file-classification.v1`，`authority` 自动要求 `authorities.v1`；未声明 authority、未知语言或事实不完整时保持 `UNAVAILABLE`，不能以零候选通过。

`authority.protected_paths` 由引擎统一解释：尾随 `/` 表示目录子树，其他值是精确文件。引擎把匹配后的原始输入文件写入 `authority.protectedFiles`；脚本应通过 `targets.authority` 或该集合消费边界，不能再实现 `normalizePath`、`startsWith`、`endsWith` 或 `includes` 的平行路径判定。change-set 规则收到的每个文件同样带有引擎派生的 `authorityIds`。

可被多个脚本复用的边界继续放在 `.openarch/config.yml` 的 `authority_hygiene.authorities`。仅服务于一条项目脚本的边界可在该脚本顶层声明一个 `authority`，无需污染共享配置：

```js
export default {
  scope: "repository",
  authority: {
    id: "local-parser-boundary",
    owner: "src/parser/service.ts",
    publicEntry: "src/parser/index.ts",
    protectedPaths: ["src/parser/"],
    prohibitedImports: ["node:child_process"],
  },
  targets: { authority: ["local-parser-boundary"] },
  stages: {},
  link: ({ records, facts }) => [],
};
```

局部声明只对当前脚本执行可见，运行时会把它合入该次只读 `facts.authorities` 并派生 `protectedFiles`/change-set `authorityIds`；它不会写回配置，也不会泄露给其他脚本。`id` 不得与项目 authority 冲突，且局部声明不接受脚本伪造的 `protectedFiles`。引擎自动要求完整的 `authorities.v1`，因此脚本无需重复在 `requires` 中登记。一个规则只能声明一个局部 authority；需要跨规则共享或组合多个 authority 时使用项目配置，保持共享边界可审计。

为降低 Agent 起步成本，运行 `openarch rules facts` 查看实际发布能力；`openarch rules skeleton staged-ast|classification|metrics|authority-import|authority-change-set` 输出最小脚本骨架，不写入项目。所有 skeleton 都是 packaged manifest 中模板文件的只读输出，CLI 不维护内嵌的第二份脚本文本。`authority-import` 用项目 authority 的 protected paths 与 prohibited imports 做 text 剪枝，再以 `static-imports.v1` 确认静态 import；它对已发布的 TS/JS、Go、Rust、Python、Java parser 使用同一模板，但动态 import、Java classpath/wildcard import、语言未解析的 import 语法或 parser 失败必须保持 unavailable。它适合把已发现的“角色不应直接使用某项能力”固化成项目防线。先从最小骨架开始，补齐输出合同和 fixture，再运行 `openarch rules check`；不要为获取 skeleton 修改 OpenArch parser 或内部注册表。

默认资产升级也必须显式：`openarch init --install-script <id>` 遇到已有目标只保持不动；当 `rules check` 指出已安装默认资产合同过期时，确认该文件没有项目定制后，运行 `openarch init --replace-script <id>` 替换该单一资产。它不会自动覆写任何项目脚本。

打包模板的物理目录也按证据作用域组织：`assets/templates/common/<engine>/` 只放不依赖某种语言 AST 的脚本或 skeleton；`assets/templates/<language>/<engine>/` 放该语言实现，例如 `typescript/anti-patterns/` 或 `rust/anti-patterns/`。根目录只保留 manifest。`id`、`target`、`pattern_family` 和用户的安装命令不从目录推导，仍完全由 manifest 权威解析；因此新增语言只增加其目录和 manifest 资产，不改变接入项目的 `.openarch` 目标路径。

## 跨语言模板族

发布 manifest 可以为可复制反模式脚本声明 `pattern_family`。它表示可跨语言讨论和校准的坏味道语义，例如 `placeholder-implementation`；它不是内置 gate，也不要求不同语言共用同一段 AST 查询。一个模板族由独立资产组成：`anti-patterns.typescript.*`、`anti-patterns.python.*`、`anti-patterns.go.*`、`anti-patterns.rust.*` 可以分别映射自己的语法、合法替代和 unavailable 边界，但保持同一模式意图与可解释 finding 分类。

`openarch rules facts` 只列出当前项目 `languages` 可安装的模板族，供 Agent 调查证据后选择 `init --install-script <id>`。列出不等于安装、启用或通过校准；项目可随时删除已复制的脚本，并移除对应 `quality_rules`。模板没有可靠语言实现时不应登记为该语言的推荐项。当前 `placeholder-implementation` 已有 TS/JS、Python、Go、Rust、Java 的独立 AST 实现；`silent-error-handling` 已有 TS/JS、Python、Java 的空 catch/except 实现。它们共享 finding 分类与建议，抽象/接口等合法声明和 rethrow/raise 替代保持各自语法边界。Go/Rust 错误值传播仍需更高阶语义，故不推荐模板。语言专项和安全专项同样使用模板族元数据，但注入/污点/CVE 等需要类型、数据流或外部扫描器的规则必须保持 provider/SCA 的独立证据边界。

## 领域边界

| 能力 | 脚本结果 | 策略/存储边界 |
|---|---|---|
| 隐式依赖 | `DiscoveredEdge[]` | `discover` 按 source 合并到 `implicit-deps.yml`；不把显式 import 或测试关联混入。 |
| 反模式 | `AntiPatternHit[]` | 默认 report-only，不改变策略、`I_push` 或 CRL。命中可附带 `category`、`severity`、`patternFamily` 和 `suggestion`，它们只改善解释与行动建议，不能替代项目策略。repository `link` 与 `change_set` `detect` 都从 `facts.authorities` 消费项目 authority 或本脚本局部 authority；后者另外只消费 CLI 提供的有界变更事实。只有 `authority_hygiene.quality_rules` 显式选中的 authority 脚本可由 `rules scan --check` 独立裁决。 |
| 测试项目脚本 | `TestFinding[]` | 脚本只产生事实；项目 `test_governance.rules` 决定 WARN/BLOCK，provider coverage 不因脚本而升级。 |

完整运行必须能显示 `input -> targets -> candidates -> records`，以便校准脚本是否真的剪枝。无 Git、无支持的语言事实或不完整的项目配置必须报告 `UNAVAILABLE/PARTIAL`，不能折算为零 finding。

隐式依赖 `link` 返回的每项必须包含非空字符串 `from`、`to`、`via`、`type`。运行时统一把端点规范化为项目根相对的 POSIX 路径，拒绝仓库外端点，并按四元组 `(from, to, via, type)` 去重后才写入 `implicit-deps.yml`。脚本直接使用引擎记录中的 `_file`，不得自行处理绝对路径、分隔符或关系去重。

`openarch rules discover` 对每条规则显示 `input -> targets -> candidates -> records`，并把“本轮识别边”与对持久化结果的 `+新增/-移除` 分开报告。相同输入连续执行应显示 `+0/-0` 且不改变 `implicit-deps.yml` 内容。

## 腐化响应闭环

OpenArch 不声称能预先枚举所有未来的坏味道。发现一个新模式后，产品应让 Agent 用低成本建立项目防线，并先清理已存在的同类问题：

```text
观察到可复现的腐化模式
  -> 调查其事实域、合法替代和证据成本
  -> 若已有 parser/编译器/Git/项目显式合同可稳定、低成本证明：选择 provider 或项目脚本
     -> openarch rules check -> 修复前 report -> 回扫、fixture、report-only 校准 -> 视证据独立升级
  -> 若依赖设计意图、运行时/业务语义、广泛类型/数据流或昂贵全程序分析：由 Skill 指导 Agent 调查
     -> 记录事实、假设、未知和处置决定；不创建伪静态脚本、不以零命中收工、不宣称 gate 覆盖
```

对“因某次已发现腐化而新建”的项目脚本，当前回扫为零是有效的 `CLEAN` 结果，不应惩罚已经完成的治理；它单独不能证明规则覆盖了被观察到的模式。提升前需要至少一份可复核正例：修复前报告、可重放的历史 revision，或从真实案例提炼的最小回归 fixture。三者都没有时才是 `UNVALIDATED`，应继续 report-only 或重新调查。预防性安装的默认脚本同样可干净起步，但没有正例证据时不提升。

`review` 的局部负担、结构暴露、历史共同变化和既有 finding 可以作为 Agent 的调查线索，帮助优先检查可能的设计坏味道；它们本身不是该坏味道的证明。脚本只承载边界明确、可重复、可由已声明事实验证的断言。不要因为分类学中存在某个名称，就把需要人类/Agent 判断的主张实现为泛化 AST 规则或产品默认门禁。

不要把“平行引擎”当成可由产品默认识别的泛化名词。应将实际观察到的可验证越界拆成项目事实，例如“静态 provider 直接 import 进程执行 API”或“runner 直接 import AST service”，以 authority 声明和 `authority-import` backscan 表达。项目脚本防住的是这些已校准的不变量；新的腐化再按同一闭环调查、抽取和固化。

`openarch rules check` 只加载项目 `.openarch/*/rules/*.mjs` 并验证默认导出及领域合同；它不执行 `link`、不遍历项目源码、也不替代扫描。合同失败以 exit 3 明确报告，避免 Agent 在错误脚本上得到“零 finding”的假象。产品分发的默认脚本与参数模板则由 manifest 驱动的 CI smoke test 验证。

## Agent 工作流

安装版 OpenArch skill 在开始脚本工作前会要求读取随插件分发的 `references/script-authoring.md`。该参考是本合同面向 Agent 的操作入口：它引导先运行 `rules facts`、选择最小 skeleton、声明事实边界并保留 fixture/校准证据；本文件仍是产品实现合同的完整说明。

1. 先调查项目的实际职责、合法入口和证据范围，并为模式分类：已有 parser、编译器、Git 或项目显式合同能稳定、低成本证明时，选择已有 provider、模板或最小项目脚本；需要设计意图、运行时/业务语义、广泛类型/数据流或昂贵全程序分析时，使用 Skill 指导的局部调查，保留不确定性与重构假设，不伪造规则结果或 gate 覆盖。
2. 脚本只写入项目 `.openarch`；不能修改打包 CLI 的 parser、注册表或内部存储来治理接入项目。
3. 需要项目分类或结构指标时，在脚本的 `requires` 中声明事实能力；需要 authority 时，先判断它是否跨脚本复用：可复用的写入 `authority_hygiene.authorities`，一次性的写入脚本顶层 `authority`。只消费 `facts`，不得重读 config/baseline 或从项目形状推断 owner。运行 `openarch rules check`，先修复合同错误，再为规则补充违规、合法替代和 unavailable fixture。
4. 保存可复核正例：治理开始时若存量仍存在，必须先写脚本、运行 `rules check` 和回扫，保留它实际命中的修复前 report，之后才改命中实现；不能先修复再用零 finding 宣称脚本有效。若存量已清理，可使用历史 revision 或从真实案例提炼的最小回归 fixture。修复后再回扫当前仓库，零命中是 `CLEAN`，并补齐违规、合法替代和 unavailable fixture。对 authority-backed 脚本，项目才可在同一 `authority_hygiene` 声明中以 `quality_rules: { "script.mjs": warn|block }` 选择提交质量动作，再运行 `rules scan --check` 验证。该裁决独立于公式和 architecture policy。当前配置审计能记录该选择，但通用的校准证据工件仍是后续能力，不能把手工声明伪装为自动校验。
5. 发现某类腐化后，先把可重复的不变量固化到合同/引擎或项目脚本，再用它扫描并清理已存量，最后同步文档、模板和分发副本。

## 强制与边界

引擎可以强制默认导出、阶段顺序、输入来源、输出校验、超时与可观测的剪枝统计。它不能安全沙箱化任意受信任 `.mjs`：脚本仍可自行导入 Node API。因此不受信任脚本必须由宿主或 CI 沙箱执行；OpenArch 的合同用于降低协作中的结构性腐化，不伪装成安全隔离。

这对应三大理论：以实际事实和 unavailable 状态代替猜测；用单一可解释的阶段事实减少平行实现的信息损失；以少量刚性合同和“发现后立即建防线、回扫存量”的闭环，阻止已知坏味道继续蔓延。
