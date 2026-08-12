import { describe, it, expect } from "vitest";
import { compareVersions, checkForUpdates, fetchLatestVersion } from "../../src/application/updateCheck";

const mockFetch = (tags: readonly { name: string }[]): typeof fetch =>
  (async () => new Response(JSON.stringify(tags), { status: 200 })) as typeof fetch;

describe("compareVersions", () => {
  it("语义化比较：0.1.0 < 0.1.1 < 0.2.0", () => {
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
    expect(compareVersions("0.1.1", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  });

  it("容忍 v 前缀与不等长段", () => {
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1", "0.1.0")).toBe(0);
  });
});

describe("fetchLatestVersion / checkForUpdates（GitHub tags API）", () => {
  it("远端有新 tag → updateAvailable=true（v 前缀剥离）", async () => {
    const tags = [{ name: "v0.2.0" }, { name: "v0.1.0" }];
    expect(await fetchLatestVersion(mockFetch(tags))).toBe("0.2.0");
    const result = await checkForUpdates("0.1.0", mockFetch(tags));
    expect(result.updateAvailable).toBe(true);
    expect(result.latest).toBe("0.2.0");
  });

  it("远端同版 tag → updateAvailable=false", async () => {
    const result = await checkForUpdates("0.1.0", mockFetch([{ name: "v0.1.0" }]));
    expect(result.updateAvailable).toBe(false);
  });

  it("无 tag → 抛错（诚实报告，不伪装成 up-to-date）", async () => {
    const empty = (async () => new Response("[]", { status: 200 })) as typeof fetch;
    await expect(fetchLatestVersion(empty)).rejects.toThrow("no release tags found");
  });
});
