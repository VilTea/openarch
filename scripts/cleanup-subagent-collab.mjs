#!/usr/bin/env node
// 清理 subagent 协作 dogfood 环境：杀死 coordination 服务并删除临时工作区。
// 用法：
//   node scripts/cleanup-subagent-collab.mjs <state.json>
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const stateFile = process.argv[2];
if (!stateFile) {
  console.error("用法: node scripts/cleanup-subagent-collab.mjs <state.json>");
  process.exit(1);
}
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const pid = Number(state.pid);
if (Number.isFinite(pid) && pid > 0) {
  try {
    process.kill(pid);
    console.log(`已请求终止 coordination 服务 pid=${pid}`);
  } catch (error) {
    if (error.code !== "ESRCH") console.error(`终止服务失败: ${error.message}`);
  }
}
const work = state.work;
if (work) {
  rmSync(work, { recursive: true, force: true });
  console.log(`已删除工作区: ${work}`);
}
