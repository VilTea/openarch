// packages/core/src/application/updateCheck.ts
// 版本更新检查（2026-08-11）：对比本地版本与远端最新 release tag。
// 只读检查，不自动下载/安装——更新动作由用户显式执行
// （下载 release 二进制、重新 init --agent 刷新 skill 树）。
export interface UpdateCheckResult {
  readonly current: string;
  readonly latest: string;
  readonly updateAvailable: boolean;
  readonly checkedAt: string;
}

const normalizeVersion = (version: string): readonly number[] =>
  version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);

/** 语义化版本比较：0.1.0 < 0.1.1 < 0.2.0；pre-release 后缀视为略低于同号。 */
export const compareVersions = (left: string, right: string): number => {
  const l = normalizeVersion(left);
  const r = normalizeVersion(right);
  for (let index = 0; index < Math.max(l.length, r.length); index++) {
    const diff = (l[index] ?? 0) - (r[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
};

/**
 * 远端版本源：GitHub tags API（最新 tag 在前）。发布即打 tag——
 * 分支 package.json 保持工作版本，tag 才是发布标识（2026-08-11 决策：
 * 快照发布不递增 package.json，update 必须读 tag 才能发现新版本）。
 */
export const REMOTE_TAGS_URL = "https://api.github.com/repos/VilTea/openarch/tags";

const stripTagPrefix = (tag: string): string => tag.replace(/^v/, "").replace(/^release-/, "");

export const fetchLatestVersion = async (fetchImpl: typeof fetch = fetch): Promise<string> => {
  const response = await fetchImpl(REMOTE_TAGS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`update check failed: HTTP ${response.status}`);
  const tags = await response.json() as readonly { readonly name?: unknown }[];
  if (!Array.isArray(tags) || tags.length === 0) throw new Error("update check failed: no release tags found");
  const name = tags[0]?.name;
  if (typeof name !== "string" || name.length === 0) throw new Error("update check failed: latest tag has no name");
  return stripTagPrefix(name);
};

export const checkForUpdates = async (
  currentVersion: string,
  fetchImpl?: typeof fetch,
): Promise<UpdateCheckResult> => {
  const latest = await fetchLatestVersion(fetchImpl);
  return {
    current: currentVersion,
    latest,
    updateAvailable: compareVersions(latest, currentVersion) > 0,
    checkedAt: new Date().toISOString(),
  };
};
