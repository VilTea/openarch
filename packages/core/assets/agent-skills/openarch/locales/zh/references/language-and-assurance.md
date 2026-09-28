# 语言与保障

> “实践、认识、再实践、再认识，这种形式，循环往复以至无穷。”——《实践论》

在依赖 parser、测试、编译器、`LSP`、`SCIP` 或外部语义能力前阅读本页。

## 可携带边界

通用产品能力是指标、baseline、provider 与脚本合同、项目源码发现和语法解析，不依赖某种语言的目录惯例。当前发行版支持 TypeScript/JavaScript、Go、Rust、Python 与 Java 的语法解析；语法支持不等于完整导入解析、测试治理、authority 分析、符号使用或安全覆盖。

语言 id 与扩展名一一对应：`typescript`（.ts/.tsx/.mts/.cts）、`javascript`（.js/.jsx/.mjs/.cjs）、`vue`（.vue）、`go`、`rust`、`python`、`java`。**vue 是独立语言**：`languages` 配置 `"vue"` 只匹配 `.vue` 文件，不包含在 `javascript` 中——项目既有 `.vue` 又有 `.js/.jsx` 时必须同时配置两者（vue 的 `<script>` 块按 js/ts 语义分析，但扩展名匹配各自独立）。

Python 已校准静态根模块、相对模块与单根隐式命名空间包映射；动态导入、`sys.path`、导入 hook、多根命名空间包或显式 Pyright 执行环境仍保持 `PARTIAL` 或 `UNAVAILABLE`。执行环境包括优先的 `pyrightconfig.json`，或没有该文件时 `pyproject.toml` 的 `[tool.pyright]`；二者的 `executionEnvironments`/`extraPaths` 命中会保留引用事实但不证明完整范围。Java 只证明常规 Maven/Gradle 根目录和显式导入；类路径、通配导入、生成源码和反射保持 `UNAVAILABLE`。其他边界以当前命令输出和 provider 覆盖为准，不从运行时安装状态推断。

## 外部语义 provider

`openarch toolchains` 只发现全局、随包、`PATH` 或平台工具，不安装或启动它们。日常机器路径优先放在用户级 `toolchains.yml`，项目本机覆盖放在 `.openarch/toolchains.local.yml`；两者的实际位置由命令显示。优先级为单项 `OPENARCH_<TOOL_ID>_PATH`（CI/临时覆盖）→ 项目本机配置 → 用户配置 → `PATH`/平台探测。`OPENARCH_TOOLCHAINS_FILE` 只允许重定向用户配置文件，不能替代每个工具的独立路径；不存在、格式错误或位于被治理项目内的可执行文件都明确不可用。项目本机文件可以有绝对路径，但不得纳入 Git 或项目策略配置。发现可执行文件只是前置事实，不证明完整语义分析。provider 报告必须带身份、证据来源和独立的声明与引用覆盖；只有完整范围才可支持内部声明的孤立结论，公开或局部事实不能降低 `I_push` 或改变门禁。

`file_kinds` 是项目一次分类、所有消费者复用的事实边界：`observed` 保留全部源码观察，`production-governance` 只进入生产指标、图与编译器/LSP 符号引用，`test-governance` 只进入测试治理，`change-evidence` 包含生产与测试。不要为获得 `complete` coverage 随意将源码标为 `auxiliary`；先阅读该文件职责，只有纯测试运行、验证输入或发布产物等确有项目证据的非产品文件才可分类。变更 `file_kinds` 后必须运行 `openarch scan` 重建基线，再运行 `openarch check --record-config` 记录配置审计。

### 分析路径

Tree-sitter 静态语法分析始终是 `I_push`、声明级 diff 和结构图的可用兜底。它依据可解析源码和静态 import 计算结构传播上界，不能证明精确的符号消费者。需要非 TypeScript 语言的符号引用、直接消费者证据或后续语义事实时，先运行 `openarch toolchains`，按对应语言页在用户级或 checkout-local 工具链配置中提供 LSP，再对**未暂存工作树**运行 `openarch check --worktree --semantic --report`。

Java 的符号级证据常依赖 jdtls 转发 daemon：`openarch toolchains` 显示 `jdtls` 不可用但 `javac` 可用时，`--semantic` 仍会 fail-closed 不输出 C_push。需要 Java 符号证据的项目先运行 `openarch lsp start` 预热 jdtls（常驻方式见 `docs/lsp-daemon-hooks.md`），再运行 `openarch check --worktree --semantic --report`；首次冷启动索引可能需要数十秒，daemon 热后显著加快。

该报告逐语言显示当前路径：`STATIC parser fallback` 表示未请求或 LSP 不可用，`LSP`/`COMPILER` 则显示 provider、声明 coverage、引用 coverage、`scope` 和风险。`scope=repository` 才可能形成完整总体；`scope=demand` 只为当前变更选择声明，双 coverage 必为 `PARTIAL`。声明族说明可比较的事实粒度，后续结论只能消费各语言共同且已校准的族。直接引用会独立进入验证计划，帮助 Agent 核查具体消费者；当前仍不改变 `I_push`、CRL、D_MR、baseline 或 gate。`PARTIAL` 保留已证明事实但不能作为零引用或完整消费者结论。`--staged --semantic` 被拒绝，因为 LSP 读取工作树而非 Git index；先在工作树取证、确认并暂存后，再运行静态 `check --staged` 封存同一快照。

### 读取语义结果

符号使用结果分别声明声明覆盖和仓库引用覆盖。只有两项都是 `COMPLETE` 的内部声明，零引用才可作为孤立候选；公开面、`UNKNOWN`、`PARTIAL` 和 `UNAVAILABLE` 都不是零引用结论。TypeScript/JavaScript 的直接静态函数、类、具名合同成员、静态属性索引和对象解构属性可以产生此类事实；受支持的 tsconfig 项目引用消费会归回受治理源码声明。接口或继承合同中的实现、对象逃逸和动态派发保持 `UNKNOWN`。不要把这些结果理解为调用图、运行时数据流或外部使用证明。

Python、Go、Rust、Java 的语义结果同样以本轮报告的 provider、范围和覆盖为准。Python 的 `__name__` 数据模型 hook 由运行时调度，不作为内部零引用候选；动态导入、反射、宏、条件编译、生成源码、别名插件或未声明的工作区形态会使结果保持 `PARTIAL` 或 `UNAVAILABLE`。`gopls` 的完整引用范围仅限单个 `go.mod` 根且没有 `go.work`、构建约束或生成 Go 源码，并要求为全部已打开的受治理源码发布诊断后再取引用；Java 的完整范围仅限常规单 Maven 根、无模块/外部依赖且未发现反射；Rust 的完整范围仅限单根 `Cargo.toml` 包、无 `build.rs`/工作区、宏调用或条件编译，并要求 Rust Analyzer 为全部已打开的受治理源码发布诊断后再取引用。没有这项就绪证据或遇到任何排除形态时保持 `PARTIAL`。其他情形不得从工具存在或空 finding 推出 clean。

## 测试 provider

发行版注册的 provider（`openarch test --list` 可查）与静态范围：

| provider id | 框架/语言 | 断言识别 |
|---|---|---|
| `typescript-vitest` | Vitest（TS/JS） | `expect(...)`/`assert(...)` 调用点，以及体内含断言的同文件包装函数 |
| `node-test` | node:test | `assert.*`，判据同上 |
| `java-junit` | JUnit 4/5（Java） | `assert*` 方法族、`@Test(expected=…)` 注解，以及体内含断言的同文件包装方法（含两跳以上链） |
| `go-testing` | Go testing | `t.Error/Fatal` 等（Go 无通用断言库，不设 missing-assertion 策略） |
| `rust-testing` | Rust `#[test]` | `assert*!` 宏；委托调用视为验证意图 |
| `python-pytest` | pytest | `assert` 语句；体内含 assert 的同文件包装函数 |

包装判据是**语法级**的（体内是否出现已识别断言调用点），不看函数命名前缀；同名多声明（重载、覆写、匿名类实现）按**并集**处理——只要有一个声明体内含断言，该名字即算包装。这个选择刻意偏向**漏报**：漏报只少扣分，误报会把没有断言的用例说成有断言。

`python-pytest` 只覆盖标准测试函数或方法、AST 确认的断言和少量直接标记或调用。Java JUnit 只覆盖标准注解与断言。Go、Rust 也只有明确的静态范围。动态标记、别名、插件、运行时条件、参数化或框架扩展保持 `PARTIAL`；runner 将实际命令与 provider 事实分开报告。

**配置 `test_governance.providers`/`runners` 时只写上表或 `openarch test --list` 列出的 id。** 报告里的"适配器建议"只是**候选**，写入前必须核对：建议与注册 id 曾经不一致（`junit` 对 `java-junit`、`rust-cargo-test` 对 `rust-testing`），照抄的后果不是"没生效"而是"未知 provider"——全部测试文件变成未识别，裁决直接变 `BLOCK`。判断建议是否可信的办法：把建议 id 回填后，`openarch test` 的覆盖状态应为 `AVAILABLE` 且 `Provider` 行不为"无"。

**断言识别的补充口径（2026-09-25 实地核实）：**

- JUnit 4 的 `@Rule`/`@ClassRule` **委托式断言**（`thrown.expect(...)`、`collector.checkThat(...)`、`addError(...)`）在**该文件声明了规则成员**时算断言；没有 `@Rule` 的同名调用不算。门控是**文件级**事实，不推断字段类型。
- **assumptions 不算断言**：`Assume.assumeTrue(false)` 是前置条件（"跳过该用例"），不是验证；体里只有 assumption 的用例仍报 `missing_assertion`。这是有意保留的边界。
- 用例体**没有任何语句**时，finding 的 kind 是 `empty_test_body`，**不再**是 `missing_assertion`：空体在夹具类语料里多是被测对象而非"忘记断言"，混在一个 kind 下信噪比约 1:1。**迁移口径**：按 `missing_assertion` 配置的策略不再命中空体，要治理空体须显式声明 `empty_test_body`。能力边界：只有能证明"体里零语句"的 provider 才发本 kind（Java 已支持；Python 无法表达空体——`pass` 本身就是语句；Go 不设该策略）。

**Java 布局与文件分类**：同时存在 `src/main/java` 与 `src/test/java` 时，`src/main/java/**` 一律算**生产**文件（Maven/Gradle/Android 通用布局），不再因为文件名以 `Test` 结尾而进入测试总体；项目显式声明的 `file_kinds` 规则优先于这条推导规则。这条推导规则参与分析范围指纹，因此分类语义变化会如实体现在兼容性报告里。

**provider 摘要的 `assertion` 口径（跨语言核实 2026-09-25）**：摘要里的 `assertion` 只统计**直接识别到的断言调用/宏**。某些 provider 对 finding 采取**更宽**的"验证意图"判据——Rust 把委托调用也算验证意图（2018-08-08 起的 Rust idiom 校准），因此 `openarch-serde` 那种 `P95 assertion=0` 与"只有 3 条 `missing_assertion`"**并存不是矛盾**：前者说"没识别到 `assert*!` 宏"，后者说"不算缺少验证意图"。读这两个数字时必须按各自定义解释，不要用一个去否定另一个。

**用例体范围明细（`--spans`）**：`openarch test --spans` 列出 provider 确认的用例体范围（`文件:起始行-结束行`）；`--json --spans` 把它投影到机器契约的用例体事实域。它是复核 DRY/DAMP 分界所用范围的取证入口，默认不输出（避免契约体积膨胀）。候选集为空时（实时发现的测试文件没有一个被已启用适配器声明支持，或没有启用适配器）该事实域如实报 `UNAVAILABLE`，不会报成"可用但为空"；候选存在但没有建立任何用例体时如实报空值，不伪造范围。

**测试覆盖的两个边界（2026-09-25）**：

- `baseline_scope_incompatible`：baseline 记录的分析范围与当前配置不一致（改过 `languages`/`file_kinds`，或升级后分类语义变化）。此时 provider 候选集来自**旧范围**，覆盖降级为 `PARTIAL`；处理方式只有一种——**完整 scan** 后重新采集。看到 `覆盖限制` 里有它，就不要在旧 baseline 上继续解读 provider 数字。
- `可发现测试文件`（实时分类）与 `provider 成功处理` 现在**是同一总体**（D-G18 起采集范围也是实时发现集合）；不一致只意味着该文件未被任何已启用适配器声明支持，或采集本身失败——原因码见 `覆盖限制`。未入 baseline 的测试文件**已有**采集事实，且逐条带 `unbaselined` 来源标记（对账缺口仍在，故覆盖降级为 `PARTIAL`）；`scan` 之后缺口才消除。

**子目录构建标记提示**：`context` 会列出**子目录**里发现、但当前 `languages` 未覆盖的构建标记（如 `complete/pom.xml → java`）。它只是提示——OpenArch **不会**据此改写 `languages`（自动探测只看项目根）。多模块项目按提示把子项目语言写入 `config.yml` 的 `languages` 即可参与分析。

### 语言形状事实（校准 2026-09-27）

这些是**已发布判据**的事实，不是可协商的惯例；写测试与判读报告时按此口径：

- **TS/JS 弱断言**：只收**有官方出处**的 `toBeTruthy` / `toBeFalsy`（Jest/Vitest 文档的 truthiness 一族）；`toBeDefined` **不在其中**（"非空"检查，无权威依据）。判据是"该用例**全部**断言皆弱"才计入。
- **Java 弱断言**：`assertNotNull` / `assertTrue` / `assertFalse`，名单由 `WEAK_JUNIT_ASSERTION_METHODS` 派生，不手抄。
- **Go**：测试名判据是官方措辞"**不以小写字母开头**"（`func TestXxx`，因此 `Test_foo` / `Test1` 合法）；Go **没有内建断言**（官方 FAQ），失败信号来自 `*testing.T` 的方法，且**该接收者必须出现在该函数的参数表里**（挡住同名 `Error()` 方法）；比较逻辑在 `if` 的**条件**形态里——`if cond { … }`（体内没有失败调用）本身是一个比较决策点；断言归属按 **offset** 判定，嵌套 `t.Run` 闭包里的断言**不归**父用例。
- **Rust**：断言宏族 = `assert` / `assert_eq` / `assert_ne` / `debug_assert*` / **`assert_matches!` / `debug_assert_matches!`**；**`matches!` 不算断言**（返回 `bool` 的表达式宏，本身不产生失败信号）。测试文件识别按 **Cargo 目标语义**：`tests/*.rs` 默认是集成测试目标；`[package] autotests = false` 时**只有 `[[test]]` 声明的目标**才被构建（`path` 可指向任意位置，省略时回退 `tests/<name>.rs`）；`[[test]] harness = false` 是自定义 harness ⇒ **不是 libtest，其 `#[test]` 不被收集**；清单不可读时**回退路径判据**（不据此排除文件）。
- **解析扩展**：语言扩展与判据实现遵守 `docs/language-parser-extension.md` §4.1 —— **正则只用于输入长度与结构都可证明有界的短文本**（例：查询里对单个捕获的 `#match?`），长文本走结构路径；读不到就报"未解析 / 不可判定"，**不猜**。
## 语义关系事实

`semantic-relations.v1` 是项目脚本可按需声明的仅报告事实，当前只表达直接可证明的 `extends`、`implements`、显式类型和 `new` 构造关系，并随结果提供来源、覆盖和证据。它不等于调用图、传递依赖、依赖注入、反射或动态派发，也不参与 `I_push`、CRL、D_MR、baseline 或门禁。脚本声明 `requires` 后只能消费本轮完整事实；不完整时必须保留 `PARTIAL/UNAVAILABLE`。
