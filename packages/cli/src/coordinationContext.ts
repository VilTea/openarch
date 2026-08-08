import { execFileSync } from "node:child_process";
import { readCoordinationConfig, statusDocsRepo } from "@openarch/core";

export interface CoordinationContextFact {
  readonly state: "not_configured" | "unavailable" | "available";
  readonly detail: string;
  readonly remoteUrl?: string;
  readonly branch?: string;
  readonly headSha?: string;
}

const localDocsRemote = (cwd: string): { remote: string; branch: string } | undefined => {
  const docs = statusDocsRepo(cwd).config;
  if (!docs) return undefined;
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: docs.target, encoding: "utf8", timeout: 5000 }).trim();
    // Local-mode docs-repo (type: "local") has no origin remote; the shared
    // directory itself is the authority, so its target path is the remote.
    if (docs.type === "local") return { remote: docs.target, branch };
    return { remote: execFileSync("git", ["remote", "get-url", "origin"], { cwd: docs.target, encoding: "utf8", timeout: 5000 }).trim(), branch };
  } catch { return undefined; }
};

/** Normalizes a remote for comparison: uniform slashes, lowercase drive letter and scheme://authority only; the path stays case-sensitive. */
const normalizedRemote = (value: string): string => {
  const withSlash = value.replace(/\\/g, "/");
  const withDrive = withSlash.replace(/^([a-zA-Z]):/, (_: string, drive: string) => `${drive.toLowerCase()}:`).replace(/\/+$/, "");
  return withDrive.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/]*)/i, (_: string, scheme: string, authority: string) => `${scheme.toLowerCase()}${authority.toLowerCase()}`);
};

export const collectCoordinationContext = async (cwd: string): Promise<CoordinationContextFact> => {
  const configured = readCoordinationConfig(cwd);
  if (configured.state !== "configured") return { state: "not_configured", detail: "coordination service is not explicitly configured" };
  try {
    const response = await fetch(new URL("/v1/docs-repo", configured.config.url), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { state: "unavailable", detail: `service returned HTTP ${response.status}` };
    const value = await response.json() as { docsRepo?: { remoteUrl?: unknown; branch?: unknown; headSha?: unknown } };
    const docsRepo = value.docsRepo ?? {};
    if (typeof docsRepo.remoteUrl !== "string" || !docsRepo.remoteUrl || typeof docsRepo.branch !== "string" || !docsRepo.branch || typeof docsRepo.headSha !== "string" || !/^[0-9a-f]{40}$/i.test(docsRepo.headSha)) return { state: "unavailable", detail: "service returned an invalid docs-repo descriptor" };
    const local = localDocsRemote(cwd);
    return local && normalizedRemote(local.remote) === normalizedRemote(docsRepo.remoteUrl) && local.branch === docsRepo.branch
      ? { state: "available", detail: "docs-repo descriptor and local DocumentStore match", remoteUrl: docsRepo.remoteUrl, branch: docsRepo.branch, headSha: docsRepo.headSha }
      : { state: "unavailable", detail: "service descriptor does not match the local DocumentStore remote/branch", remoteUrl: docsRepo.remoteUrl, branch: docsRepo.branch, headSha: docsRepo.headSha };
  } catch (error) { return { state: "unavailable", detail: error instanceof Error ? error.message : String(error) }; }
};
