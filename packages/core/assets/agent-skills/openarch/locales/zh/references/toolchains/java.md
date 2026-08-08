# Java 工具链配置

Java 符号使用需要 `jdtls` 与 `javac`。`javac` 优先由 `JAVA_HOME`、`PATH` 或平台 JDK 发现；JDT LS 通常需要在用户级配置中声明：

```yaml
version: 1
tools:
  jdtls:
    executable: "<jdtls.bat 或 jdtls 的绝对路径>"
```

若 `javac` 也无法发现，可同样填写 `javac.executable`。运行 `openarch toolchains` 确认两项 `AVAILABLE`，再对未暂存改动运行 `openarch check --worktree --semantic --report`，确认报告实际显示 `java-jdtls-symbol-use` 及其 coverage。完整引用只在单 Maven 根、无外部依赖或模块、常规源码根且未发现反射入口的校准范围内成立；其他形态必须保留 `PARTIAL`。准备提交时仍运行不带 `--semantic` 的 `openarch check --staged --report`。
