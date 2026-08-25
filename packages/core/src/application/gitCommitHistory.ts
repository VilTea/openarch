import { resolve } from "node:path";
import { execFileHidden } from "../infra/childProcess";
import { isAnalyzableProjectFile, readProjectFileKindRules, readProjectLanguages } from "../projectFiles";
import type { EvolutionChangeKind, EvolutionChangeSet } from "../domain/evolutionSignals";
import { toPosixPath } from "../infra/paths";

export type GitCommitHistory =
  | { readonly availability: "available"; readonly changeSets: readonly EvolutionChangeSet[] }
  | { readonly availability: "unavailable"; readonly changeSets: readonly []; readonly reason: string };

/** Commit boundaries are the only trustworthy source for historical co-change. */
export const collectGitCommitHistory = (cwd: string, maxCommits = 100): GitCommitHistory => {
  try {
    const languages = readProjectLanguages(cwd);
    const fileKindRules = readProjectFileKindRules(cwd);
    const raw = execFileHidden("git", ["log", `--max-count=${maxCommits}`, "--format=%H", "--relative", "--name-status", "--no-renames"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
    });
    const changeSets: EvolutionChangeSet[] = [];
    let current: { id: string; files: string[]; changes: { path: string; kind: EvolutionChangeKind }[] } | undefined;
    for (const line of raw.split(/\r?\n/)) {
      const value = line.trim();
      if (/^[0-9a-f]{40}$/i.test(value)) {
        if (current) changeSets.push(current);
        current = { id: value, files: [], changes: [] };
        continue;
      }
      if (!value || !current) continue;
      const match = /^([AMD])\t(.+)$/.exec(value);
      if (!match) continue;
      const [, status, path] = match;
      if (!isAnalyzableProjectFile(resolve(cwd, path), { cwd, languages, fileKindRules, population: "production-governance" })) continue;
      const normalizedPath = toPosixPath(path);
      current.files.push(normalizedPath);
      current.changes.push({ path: normalizedPath, kind: status === "A" ? "added" : status === "D" ? "deleted" : "modified" });
    }
    if (current) changeSets.push(current);
    return { availability: "available", changeSets };
  } catch (error) {
    return { availability: "unavailable", changeSets: [], reason: error instanceof Error ? error.message : String(error) };
  }
};
