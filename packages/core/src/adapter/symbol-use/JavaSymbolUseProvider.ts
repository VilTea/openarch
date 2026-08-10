import type { SymbolUseRequest } from "../../port/SymbolUseService";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative } from "node:path";
import type { SymbolUseProvider, SymbolUseProviderContext } from "../../symbol-use/provider";
import { collectLspSymbolUse, type LspSymbolUseDefinition, type LspSymbolUseRuntime } from "./LspSymbolUse";
import { jdtlsDaemonStatus } from "./jdtlsDaemon";
import { toPosixPath } from "../../infra/paths";

const javaDefinition = {
  language: "java",
  providerId: "java-jdtls-symbol-use",
  languageId: "java",
  declarationQueries: [
    { kind: "function", pattern: "(method_declaration name: (identifier) @name)" },
    { kind: "class", pattern: "(class_declaration name: (identifier) @name)" },
  ],
  isInternal: (_name, source, startIndex) => !/\b(?:public|protected)\b/.test(source.slice(Math.max(0, source.lastIndexOf("\n", startIndex) + 1), startIndex)),
  // JDT 的 LSP 请求单线程串行——并发 references 排队超时（校准 2026-08-06）
  candidateConcurrency: 1,
  // 转发 daemon 优先（校准 2026-08-06：Java 单项目符号级刚需）：jdtls 无服务端
  // 监听（CLIENT_PORT 单向），hook 启动的转发 daemon（长驻 jdtls + tcp server +
  // 会话转发，同一进程接受重复 initialize——实测会话 2 响应 0.0s）让 check 复用
  // JVM 与 Maven 状态。daemon 未运行（非 hook 环境）→ fallback spawn：
  // jdtls.bat 是 python 包装（python "%~dp0/jdtls" %*），cmd /c 引号包装下带参数
  // 损坏 %~dp0（退出 1）——检测 .bat 改为 python 直接跑无扩展脚本；-data 用稳定
  // 目录（LOCALAPPDATA/openarch/jdtls/<cwd-hash>，磁盘索引增量加载）。
  launch: (executable, cwd) => {
    const daemon = jdtlsDaemonStatus(cwd);
    if (daemon.running && daemon.state) {
      return { command: "jdtls-daemon", args: [], transport: "tcp", host: "127.0.0.1", port: daemon.state.port };
    }
    const args = ["-data", jdtlsDataDir(cwd)];
    return executable.toLowerCase().endsWith(".bat")
      ? { command: process.env.OPENARCH_PYTHON ?? "python", args: [executable.replace(/\.bat$/i, ""), ...args] }
      : { command: executable, args };
  },
  sourceRisks: [{
    reason: "Java reflection is outside the calibrated symbol-use scope",
    detected: (source) => /\b(?:Class\s*\.\s*forName|get(?:Declared)?(?:Method|Constructor)\s*\(|(?:Method|Constructor)\s*\.\s*invoke\s*\()/.test(source),
  }],
  workspaceScope: {
    repositoryReferenceRisks: ({ cwd, files }) => {
      const pom = join(cwd, "pom.xml");
      const manifest = existsSync(pom) ? readFileSync(pom, "utf8") : "";
      const unconventionalSource = files.some((file) => !/^(src\/(?:main|test)\/java\/)/.test(relative(cwd, file).replace(/\\/g, "/")));
      return [
        ...(!manifest ? ["Java symbol-use requires a Maven pom.xml rooted at the governed project"] : []),
        ...(/<modules\b|<dependencies\b/i.test(manifest) ? ["Maven modules or external dependencies are outside the calibrated Java symbol-use scope"] : []),
        ...(existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts")) ? ["Gradle projects are outside the calibrated Java symbol-use scope"] : []),
        ...(unconventionalSource ? ["Java source outside conventional src/main|test/java roots is outside the calibrated scope"] : []),
      ];
    },
  },
} satisfies LspSymbolUseDefinition;

export type JavaSymbolUseRuntime = LspSymbolUseRuntime;

/**
 * 稳定 jdtls -data（Eclipse workspace）目录：按 cwd hash 隔离，存 LOCALAPPDATA
 * （持久，系统重启后仍复用索引）。jdtls 冷启动 250s 的根因是每次新临时 -data
 * 全量重建；稳定目录让二次会话走增量索引加载。
 */
export const jdtlsDataDir = (cwd: string): string => {
  const hash = createHash("sha256").update(toPosixPath(cwd)).digest("hex").slice(0, 12);
  const base = process.env.LOCALAPPDATA ?? tmpdir();
  return join(base, "openarch", "jdtls", hash);
};

export const collectJavaSymbolUse = (input: SymbolUseRequest, runtime: JavaSymbolUseRuntime) =>
  collectLspSymbolUse(input, runtime, javaDefinition);

/** JDT LS must see the same JDK whose compiler satisfied the provider contract. */
/** Adds the compiler bin directory without inventing JAVA_HOME for arbitrary PATH shims. */
const environmentForJavac = (javac: string | undefined): NodeJS.ProcessEnv | undefined => {
  if (!javac) return undefined;
  let resolved = javac;
  try { resolved = realpathSync(javac); } catch { /* Keep an explicitly configured path usable. */ }
  const bin = dirname(resolved);
  const javaHome = basename(bin).toLowerCase() === "bin" ? dirname(bin) : undefined;
  return {
    ...process.env,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
  };
};

export const javaSymbolUseProvider: SymbolUseProvider = {
  id: javaDefinition.providerId,
  evidenceSource: "lsp",
  languages: ["java"],
  requiredToolchains: ["jdtls", "javac"],
  collect: (input, context: SymbolUseProviderContext) => collectJavaSymbolUse(input, {
    parser: context.parser,
    executable: context.toolchains.get("jdtls")?.executable,
    environment: environmentForJavac(context.toolchains.get("javac")?.executable),
  }),
};
