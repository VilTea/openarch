/**
 * OpenArch DSH 插件 — 工具执行层（Host 纯逻辑，无工具注册）。
 *
 * 从 openarch-tools.mjs 拆出的子进程执行与结果处理：verdict 映射、
 * 有界文本尾部、后台任务输出缓冲、执行器接缝、CLI 前台运行、
 * scan 后台任务生产者。拆分动机：控制单文件局部负担
 * （openarch check 曾对 openarch-tools.mjs 报 crl_local WARN）。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { strictConfig } from "./openarch-contract.mjs";
import { DEFAULTS } from "./openarch-state.mjs";

const execFileAsync = promisify(execFile);

const VERDICT_BY_CODE = { 0: "PASS", 1: "WARN", 2: "BLOCK" };

/** 退出码 → verdict；null（信号终止）与 3（内部错误）都是 ERROR。 */
export const verdictOf = (code) => (VERDICT_BY_CODE[code] ?? "ERROR");

/** 有界文本尾部：超长时保留末 cap 字符并注明截断量。 */
export const tailChars = (text, cap) => {
  if (typeof text !== "string" || text.length <= cap) return text ?? "";
  return `\n[report truncated: ${text.length - cap} chars omitted]\n${text.slice(-cap)}`;
};

/** 有界滚动尾部：scan 后台任务的输出缓冲（保留最后 maxChars，游标式增量读取）。 */
export function createTail(maxChars) {
  let chunks = [];
  let cursor = 0;
  return {
    push(text) {
      if (typeof text !== "string" || text.length === 0) return;
      chunks.push(text);
      const joined = chunks.join("");
      if (joined.length > maxChars) {
        chunks = [joined.slice(-maxChars)];
        cursor = Math.max(0, cursor - (joined.length - maxChars));
      }
    },
    delta() {
      const joined = chunks.join("");
      const out = joined.slice(cursor);
      cursor = joined.length;
      return out;
    },
    text() {
      return chunks.join("");
    },
  };
}

/** 取执行器接缝：测试注入优先，否则用真实 child_process。 */
export const seamOf = (ctx, key, fallback) => {
  const service = ctx.get(key);
  return service && typeof service === "object" && service !== null ? service : fallback;
};

export const execSeamOf = (ctx) => seamOf(ctx, "openarch.exec", { execFile: execFileAsync });

export const spawnSeamOf = (ctx) => seamOf(ctx, "openarch.spawn", { spawn });

export const cwdSeamOf = (ctx, fallback) => {
  const seam = ctx.get("openarch.cwd");
  return seam && typeof seam.value === "string" ? seam.value : fallback;
};

/**
 * 工具执行会话的工作区定位：优先 exec.agent.session.header.cwd（会话头部
 * 记录的工作区），其次 session.cwd，最后行配置 cwd。多工作区场景下每个
 * 会话的 openarch_* 工具都作用在自己项目上。
 */
export const sessionCwdOf = (exec, options) => {
  const header = exec?.agent?.session?.header?.cwd;
  if (typeof header === "string" && header.length > 0) return header;
  const session = exec?.agent?.session?.cwd;
  if (typeof session === "string" && session.length > 0) return session;
  return options.cwd;
};

/** 合并配置：显式数字优先，其余取默认；未知键由 dsh-config.schema.json 白名单拦截。 */
export const pickConfig = (config = {}) => {
  const clean = strictConfig(config);
  return {
    ...DEFAULTS,
    ...clean,
    stateTtlMs: typeof clean.stateTtlMs === "number" ? clean.stateTtlMs : DEFAULTS.stateTtlMs,
    cwd: typeof clean.cwd === "string" && clean.cwd.length > 0 ? clean.cwd : process.cwd(),
  };
};

/**
 * 前台运行一次 openarch 子命令，返回有界结果。
 * 失败 fail-closed：不抛异常，返回 { ok: false, error }。
 * execFile 对非零退出码会 reject，但错误对象携带 stdout/stderr/code ——
 * 那是正常的有结论运行，不是故障。
 */
export async function runCli(ctx, options, args, timeoutMs = options.cliTimeoutMs, cwd = options.cwd) {
  const { execFile: run } = execSeamOf(ctx);
  try {
    const { stdout, stderr } = await run(options.openarchBin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: options.cliMaxBuffer,
      windowsHide: true,
      encoding: "utf8",
    });
    return { ok: true, exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    const code = typeof error?.code === "number" ? error.code : null;
    if (code !== null && code !== undefined) {
      return {
        ok: true,
        exitCode: code,
        stdout: typeof error.stdout === "string" ? error.stdout : "",
        stderr: typeof error.stderr === "string" ? error.stderr : "",
      };
    }
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: String(error && error.message ? error.message : error),
    };
  }
}

/**
 * 后台 scan 任务生产者：对接 DSH `jobs` 注册表（JobStart/JobHooks 契约）。
 * readOutput 返回游标增量（stream 语义），done 结算最终状态。
 */
export function makeScanJob(ctx, options, args, tail) {
  const { spawn: spawnChild } = spawnSeamOf(ctx);
  const child = spawnChild(options.openarchBin, args, {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let cancelled = false;
  let settled = false;
  const onData = (chunk) => tail.push(typeof chunk === "string" ? chunk : String(chunk ?? ""));
  if (child && typeof child.on === "function") {
    child.stdout?.on?.("data", onData);
    child.stderr?.on?.("data", onData);
  }
  const done = new Promise((resolve) => {
    const settle = (status, detail) => {
      if (settled) return;
      settled = true;
      resolve({ status, detail, output: tail.text() });
    };
    if (child && typeof child.on === "function") {
      child.on("close", (code) => settle(cancelled ? "killed" : code === 0 ? "completed" : "failed", cancelled ? "cancelled" : `exit code: ${code}`));
      child.on("error", (error) => settle("failed", String(error && error.message ? error.message : error)));
    } else {
      settle(cancelled ? "killed" : "completed", cancelled ? "cancelled" : "exit code: unknown");
    }
  });
  return {
    cancel() {
      cancelled = true;
      try {
        child?.kill?.();
      } catch {
        // kill 失败不影响 done 结算（close 事件或进程自然退出）。
      }
    },
    done,
    readOutput: () => tail.delta(),
  };
}
