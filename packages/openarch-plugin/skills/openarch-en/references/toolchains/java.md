# Java Toolchain Configuration

Java symbol use needs `jdtls` and `javac`. `javac` is discovered from `JAVA_HOME`, `PATH`, or a platform JDK; JDT LS commonly needs a user configuration entry:

```yaml
version: 1
tools:
  jdtls:
    executable: "<absolute path to jdtls or jdtls.bat>"
```

Add `javac.executable` only when automatic discovery cannot find it. Run `openarch toolchains` and require both tools to be `AVAILABLE`, then run `openarch check --worktree --semantic --report` for unstaged work and confirm that it reports `java-jdtls-symbol-use` with coverage. Complete references apply only to the calibrated single-Maven-root, dependency-free, conventional-source, non-reflective scope; all other shapes remain `PARTIAL`. Use `openarch check --staged --report` without `--semantic` before committing.
