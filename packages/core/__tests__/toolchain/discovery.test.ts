import { describe, expect, it } from "vitest";
import { discoverSemanticToolchains } from "../../src/toolchain/discovery";
import type { ToolchainRuntime } from "../../src/toolchain/types";

const runtime = (overrides: Partial<ToolchainRuntime> = {}): ToolchainRuntime => ({
  platform: "win32",
  environment: { ProgramFiles: "C:/Program Files" },
  resolveExecutable: () => undefined,
  exists: () => false,
  isFile: () => false,
  readDirectory: () => [],
  readFile: () => undefined,
  hasPackage: () => false,
  isProjectLocalExecutable: () => false,
  version: () => ({ ok: true, output: "tool 1.0" }),
  ...overrides,
});

describe("discoverSemanticToolchains", () => {
  it("records the bundled TypeScript compiler without requiring an external executable", () => {
    expect(discoverSemanticToolchains("C:/project", ["typescript"], runtime({ hasPackage: (name) => name === "typescript" }))).toEqual([
      expect.objectContaining({ language: "typescript", availability: "available", tools: [expect.objectContaining({ id: "typescript-compiler", location: "bundled" })] }),
    ]);
  });

  it("prefers JAVA_HOME for javac but keeps a missing JDT LS as a partial Java toolchain", () => {
    const javaHome = "C:/JDK";
    const report = discoverSemanticToolchains("C:/project", ["java"], runtime({
      environment: { JAVA_HOME: javaHome },
      exists: (path) => path.replaceAll("\\", "/") === "C:/JDK/bin/javac.exe",
    }))[0];

    expect(report).toMatchObject({ language: "java", availability: "partial" });
    expect(report.tools).toContainEqual(expect.objectContaining({ id: "javac", availability: "available", location: "environment" }));
    expect(report.tools.find((tool) => tool.id === "javac")?.executable?.replaceAll("\\", "/")).toBe("C:/JDK/bin/javac.exe");
    expect(report.tools).toContainEqual(expect.objectContaining({ id: "jdtls", availability: "unavailable" }));
  });

  it("retains a resolved executable as partial when its version probe cannot complete", () => {
    const report = discoverSemanticToolchains("/project", ["go"], runtime({
      platform: "linux",
      resolveExecutable: (name) => name === "gopls" ? "/tools/gopls" : undefined,
      version: () => ({ ok: false, reason: "timed out" }),
    }))[0];

    expect(report).toMatchObject({ language: "go", availability: "partial" });
    expect(report.tools).toContainEqual(expect.objectContaining({ id: "gopls", availability: "partial", executable: "/tools/gopls", reason: "timed out" }));
    expect(report.tools).toContainEqual(expect.objectContaining({ id: "go", availability: "unavailable" }));
  });

  it("uses PATH before a platform JDK when JAVA_HOME is absent or invalid", () => {
    const report = discoverSemanticToolchains("C:/project", ["java"], runtime({
      environment: { ProgramFiles: "C:/Program Files" },
      resolveExecutable: (name) => name === "javac" ? "C:/tools/javac.exe" : undefined,
      readDirectory: (path) => path === "C:/Program Files/Eclipse Adoptium" ? ["jdk-platform"] : [],
      exists: (path) => path.replaceAll("\\", "/") === "C:/Program Files/Eclipse Adoptium/jdk-platform/bin/javac.exe",
    }))[0];

    expect(report.tools).toContainEqual(expect.objectContaining({ id: "javac", location: "path", executable: "C:/tools/javac.exe" }));
  });

  it("honors an explicit external tool path without searching the governed project or PATH", () => {
    const report = discoverSemanticToolchains("C:/project", ["go"], runtime({
      environment: { OPENARCH_GOPLS_PATH: "C:/tools/gopls.exe", OPENARCH_GO_PATH: "C:/tools/go.exe" },
      exists: (path) => path === "C:/tools/gopls.exe" || path === "C:/tools/go.exe",
      isFile: (path) => path === "C:/tools/gopls.exe" || path === "C:/tools/go.exe",
      resolveExecutable: () => "C:/project/.tools/gopls.exe",
      version: () => ({ ok: true, output: "gopls v0.23.0" }),
    }));

    expect(report).toEqual([expect.objectContaining({
      language: "go",
      availability: "available",
      tools: expect.arrayContaining([
        expect.objectContaining({ id: "gopls", location: "environment", executable: "C:/tools/gopls.exe" }),
        expect.objectContaining({ id: "go", location: "environment", executable: "C:/tools/go.exe" }),
      ]),
    })]);
  });

  it("uses a user configuration file without one environment variable per tool", () => {
    const userConfig = "C:/Users/test/AppData/Roaming/OpenArch/toolchains.yml";
    const report = discoverSemanticToolchains("C:/project", ["java"], runtime({
      environment: { APPDATA: "C:/Users/test/AppData/Roaming" },
      readFile: (path) => path.replaceAll("\\", "/") === userConfig
        ? "version: 1\ntools:\n  jdtls:\n    executable: C:/tools/jdtls.bat\n  javac:\n    executable: C:/tools/javac.exe\n"
        : undefined,
      exists: (path) => path === "C:/tools/jdtls.bat" || path === "C:/tools/javac.exe",
      isFile: (path) => path === "C:/tools/jdtls.bat" || path === "C:/tools/javac.exe",
    }))[0];

    expect(report).toMatchObject({ language: "java", availability: "available" });
    expect(report.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "jdtls", location: "user-config", executable: "C:/tools/jdtls.bat" }),
      expect.objectContaining({ id: "javac", location: "user-config", executable: "C:/tools/javac.exe" }),
    ]));
  });

  it("propagates a machine-local env block from toolchains.yml into the tool fact", () => {
    const userConfig = "C:/Users/test/AppData/Roaming/OpenArch/toolchains.yml";
    const report = discoverSemanticToolchains("C:/project", ["go"], runtime({
      environment: { APPDATA: "C:/Users/test/AppData/Roaming" },
      readFile: (path) => path.replaceAll("\\", "/") === userConfig
        ? "version: 1\ntools:\n  gopls:\n    executable: C:/tools/gopls.exe\n    env:\n      PATH: 'C:/tools/go/bin;%PATH%'\n"
        : undefined,
      exists: (path) => path === "C:/tools/gopls.exe",
      isFile: (path) => path === "C:/tools/gopls.exe",
    }))[0];

    expect(report).toMatchObject({ language: "go", availability: "partial" });
    expect(report.tools).toContainEqual(expect.objectContaining({
      id: "gopls",
      location: "user-config",
      executable: "C:/tools/gopls.exe",
      env: { PATH: "C:/tools/go/bin;%PATH%" },
    }));
  });

  it("lets checkout-local configuration override the user configuration", () => {
    const report = discoverSemanticToolchains("C:/project", ["java"], runtime({
      environment: { APPDATA: "C:/Users/test/AppData/Roaming" },
      readFile: (path) => path.replaceAll("\\", "/").endsWith("/toolchains.yml")
        ? "version: 1\ntools:\n  jdtls:\n    executable: C:/tools/user-jdtls.bat\n"
        : path.replaceAll("\\", "/").endsWith("/.openarch/toolchains.local.yml")
          ? "version: 1\ntools:\n  jdtls:\n    executable: C:/tools/project-jdtls.bat\n"
          : undefined,
      exists: (path) => path === "C:/tools/project-jdtls.bat" || path.replaceAll("\\", "/") === "C:/JDK/bin/javac.exe",
      isFile: (path) => path === "C:/tools/project-jdtls.bat",
    }))[0];

    expect(report.tools).toContainEqual(expect.objectContaining({ id: "jdtls", location: "project-config", executable: "C:/tools/project-jdtls.bat" }));
  });

  it("refuses a tool resolved only inside the project root", () => {
    const report = discoverSemanticToolchains("C:/project", ["python"], runtime({
      resolveExecutable: (name) => name === "pyright-langserver" ? "C:/project/.venv/Scripts/pyright-langserver.exe" : undefined,
      isProjectLocalExecutable: (_cwd, executable) => executable.replaceAll("\\", "/").startsWith("C:/project/"),
    }))[0];

    expect(report).toMatchObject({ language: "python", availability: "unavailable" });
    expect(report.tools).toEqual([expect.objectContaining({ id: "pyright", reason: expect.stringContaining("inside the project") })]);
  });

  it("does not run a version command for an LSP launcher", () => {
    let versionCalls = 0;
    const report = discoverSemanticToolchains("C:/project", ["python"], runtime({
      resolveExecutable: (name) => name === "pyright-langserver" ? "C:/tools/pyright-langserver.cmd" : undefined,
      version: () => { versionCalls += 1; return { ok: false, reason: "must not run" }; },
    }))[0];

    expect(report.tools).toEqual([expect.objectContaining({ id: "pyright", availability: "available", executable: "C:/tools/pyright-langserver.cmd" })]);
    expect(versionCalls).toBe(0);
  });
});
