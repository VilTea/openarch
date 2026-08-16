// packages/core/src/adapter/symbol-use/jdtlsDaemonEntry.ts
// 独立 LSP 转发 daemon 进程入口：`node <entry> --cwd <cwd> --launch <json> [--kind <jdtls|gopls>]`。
// openarch lsp start 以 detached 方式启动本入口（CLI 退出后 daemon 继续存活）。
import { runGoplsDaemonProcess, runJdtlsDaemonProcess } from "./jdtlsDaemon";
import type { LspLaunchSpec } from "../lsp/NodeLspSession";

const args = process.argv.slice(2);
const cwdIndex = args.indexOf("--cwd");
const launchIndex = args.indexOf("--launch");
const kindIndex = args.indexOf("--kind");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : undefined;
const launch = launchIndex >= 0 ? args[launchIndex + 1] : undefined;
const kind = kindIndex >= 0 ? args[kindIndex + 1] : "jdtls";

if (!cwd || !launch || !["jdtls", "gopls"].includes(kind)) {
  console.error("lsp daemon 入口需要 --cwd <cwd> --launch <json> [--kind <jdtls|gopls>]");
  process.exit(1);
}

const spec = JSON.parse(launch) as LspLaunchSpec;
const { pid, port } = kind === "gopls"
  ? runGoplsDaemonProcess(cwd, spec)
  : runJdtlsDaemonProcess(cwd, spec);
// 启动完成信号；stdio ignore（detached）时 stdout 写入可能 EPIPE——不致命
try {
  console.log(`[openarch-lsp] ${kind} daemon ready pid=${pid} port=${port}`);
} catch { /* detached ignore */ }
try {
  console.error(`[openarch-lsp] ${kind} launch: ${spec.command} ${(spec.args ?? []).join(" ")}`);
} catch { /* detached ignore */ }
