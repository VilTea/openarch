// 固化 symbol-scope durable 校准样本（校准 2026-08-08）：从项目自身 Git 历史版本对
// （HEAD~N → HEAD）收集真实符号观察（matched/added→positive，removed→negative），
// 按 declaration family 分组写入 .openarch/calibration/symbol/。
// 用途：calibration_samples admission 依据（有 eligible profile → available）。
// 用法：pnpm exec tsx scripts/seed-symbol-calibration.mjs [revision]
import { execSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { collectTypeScriptSymbolVersionPair } from "../src/application/symbolVersionPair";
import { recordSymbolCalibrationProfile } from "../src/application/symbolCalibration";
import { createSymbolCalibrationSample } from "../src/domain/symbolCalibration";
import { makeJsonFileStorageLive } from "../src/adapter/storage/JsonFileStorage";

const cwd = process.argv[3] ?? "E:/workspace/llm/openarch";
const revision = process.argv[2] ?? "HEAD~10";
const pair = collectTypeScriptSymbolVersionPair(cwd, revision);
if (pair.availability !== "available") {
  console.error(`version pair ${revision} unavailable: ${pair.reason ?? "unknown"}`);
  process.exit(1);
}

const observations = pair.declarations.map((d) => ({
  report: pair,
  id: `openarch-self:${d.identity}`,
  identity: d.identity,
  expected: d.status === "matched" ? "matched" : "rejected",
}));

// 按 declaration family 分组（profile 契约：单 family + 单 population）
const byFamily = new Map<string, typeof observations>();
for (const obs of observations) {
  const sample = createSymbolCalibrationSample(pair, { id: obs.id, identity: obs.identity, expected: obs.expected });
  byFamily.set(sample.declarationFamily, [...(byFamily.get(sample.declarationFamily) ?? []), obs]);
}

// 清旧样本（重跑幂等：同 revision 的 profile 是 content-addressed 的，重建覆盖）
const calDir = join(cwd, ".openarch", "calibration", "symbol");
if (existsSync(calDir)) for (const name of readdirSync(calDir)) rmSync(join(calDir, name));

const store = makeJsonFileStorageLive(join(cwd, ".openarch"));
for (const [family, group] of byFamily) {
  const profile = await Effect.runPromise(recordSymbolCalibrationProfile(group).pipe(Effect.provide(store)));
  console.log(`[${family}] positive=${profile.positiveSampleCount} negative=${profile.negativeSampleCount} availability=${profile.availability} eligible=${profile.eligible}`);
  for (const reason of profile.reasons.slice(0, 2)) console.log(`  - ${reason}`);
}
console.log("校准样本已写入", calDir);
