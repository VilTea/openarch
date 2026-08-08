# 本地发行验证

OpenArch 可以在不发布 npm registry 的前提下，生成可安装的本地 tarball 或可直接运行的本地二进制 bundle。两条链路都验证发行边界，而不是工作区中的 `tsx` 开发命令。

```bash
pnpm release:local
```

命令会先运行完整 lint/test，随后在 `artifacts/local/` 生成三份 tarball：`@openarch/core`、`@openarch/cli` 与 `@openarch/plugin`。本地 beta 的 CLI tarball 以标准 `bundledDependencies` 携带唯一内部依赖 core，避免解析未发布的 `@openarch/core` registry 包；CLI 发行依赖显式覆盖 core 的第三方运行依赖，并由包合同测试防止清单漂移。它会在隔离临时项目仅安装 CLI tarball，并执行已安装的 `openarch --help`、`rules skeleton classification` 和单文件 TypeScript `scan`，分别验证命令、模板资产和 WASM grammar；任何一步失败都不应把该产物当作可测试发行物。

`pnpm release:local` 是发行者在 OpenArch 工作区执行的打包命令，不是用户运行 OpenArch 的方式。产物可以按普通 CLI 安装；例如将 beta 安装到本机命令路径后，目标项目只需要直接调用 `openarch`：

```bash
npm install --global artifacts/local/openarch-cli-<version>.tgz
cd /path/to/target-project
openarch init
openarch scan
openarch check
```

也可以把 tarball 作为项目开发依赖安装。此时 `pnpm exec openarch` 只是包管理器解析该项目已安装的 `bin/openarch.js`，并不执行 OpenArch 源码工作区；后续由 `init --install-hook` 生成的 hook 会自动解析项目的 `node_modules/.bin/openarch`：

```bash
pnpm add -D artifacts/local/openarch-cli-<version>.tgz
pnpm exec openarch init
```

本地发行的验收标准是：在没有 OpenArch 源码、且 PATH 仅指向安装产物的环境中，`openarch` 能完成真实项目的命令。2026-07-18 已在 FateOrDice 以隔离安装前缀执行 `openarch scan`（34 文件）和 `openarch check`（PASS）；该项目的依赖清单和 lockfile 未被修改。

插件 tarball 是本地安装测试资产；其 Skill 仍只调用 PATH 中的 `openarch` 或项目显式 `OPENARCH_BIN`。本地 beta 包携带 TypeScript 源码与 `tsx` runtime：`bin/openarch.js` 是 Node 启动 shim，所有命令选择和业务逻辑在 `src/main.ts` 与 TypeScript 模块中。不要把它替换为指向开发工作区的 launcher。

`artifacts/` 是本地构建产物，不纳入 Git。未来改为预编译或 bundle 时，必须继续保留“tarball 安装后执行真实命令”的验证，而不能只验证 `dist` 存在。

## 本地二进制 Bundle

```bash
pnpm release:binary
```

该命令使用 Bun 为当前宿主平台生成 `artifacts/binary/openarch-<platform>-<arch>/openarch[.exe]`，并在同级 `resources/` 放入唯一脚本模板资产、`web-tree-sitter.wasm` 与全部已发布语言 grammar。core 的 `runtimeAssets` 模块统一管理资源所有权：未设置 `OPENARCH_RESOURCE_ROOT` 时，模板/grammar 和 Tree-sitter runtime 都先从实际 executable 的同级 `resources/` 定位；仅当该资源不存在时，npm/source 执行才回退 package root 或 `web-tree-sitter` 依赖包。`OPENARCH_RESOURCE_ROOT` 只用于显式受管部署覆盖，不是正常安装前提。不得由各功能自行推导资源路径。

发行探针会先把完整 bundle 复制到一个临时“安装目录”，再从该目录调用 `--help`、`rules skeleton classification` 以及 TypeScript、Go、Rust、Python、Java 各一份最小源码的 `scan`。Tree-sitter runtime 初始化在进程内按 WASM runtime 和 grammar 分别共享 in-flight 初始化，grammar 由 OpenArch 以二进制读入后交给 `web-tree-sitter`，因此不依赖 Bun/Node 对本地路径的不同判定。二进制不是单文件承诺：移动、复制或设置 `OPENARCH_BIN` 时必须连同 `resources/` 一并保留。当前产物是本机平台的本地验证资产，不是 npm 发布、跨平台 release matrix 或签名发行物。

### Windows 本机命令安装

Windows 开发机可运行：

```bash
pnpm release:local-command
```

该管线先执行既有 `release:binary` 构建与隔离探针，再将整个 bundle（`openarch.exe` 和同级 `resources/`）通过 staging/backup 目录级替换安装到当前用户的 `%LOCALAPPDATA%\\OpenArch\\bin`，并幂等加入用户级 `PATH`。安装脚本随后直接执行安装后的 `openarch --help`，并在独立 Python 项目执行真实 `scan`；不以文件存在、PATH 命中或源码回退替代语法解析验收。首次安装后需新开终端或 Agent 会话；后续每次源码更新重复同一命令即可更新本机通用 `openarch`，不应把源码路径或资源环境变量写入任何受治理项目的配置或 Agent 指令。
