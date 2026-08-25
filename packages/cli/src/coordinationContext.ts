import { CoordinationError, execFileHidden, fetchDocsRepoDescriptor, readCoordinationConfig, statusDocsRepo, type DocsRepoDescriptor } from "@openarch/core";

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
    const branch = execFileHidden("git", ["branch", "--show-current"], { cwd: docs.target, encoding: "utf8", timeout: 5000 }).trim();
    // Local-mode docs-repo (type: "local") has no origin remote; the shared
    // directory itself is the authority, so its target path is the remote.
    if (docs.type === "local") return { remote: docs.target, branch };
    return { remote: execFileHidden("git", ["remote", "get-url", "origin"], { cwd: docs.target, encoding: "utf8", timeout: 5000 }).trim(), branch };
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
  let descriptor: DocsRepoDescriptor;
  try {
    descriptor = await fetchDocsRepoDescriptor(configured.config.url);
  } catch (error) {
    if (error instanceof CoordinationError) {
      const detail = error.cause === "http_status"
        ? `service returned HTTP ${error.status ?? "error"}: ${error.message}`
        : error.message;
      return { state: "unavailable", detail };
    }
    return { state: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  }
  const local = localDocsRemote(cwd);
  return local && normalizedRemote(local.remote) === normalizedRemote(descriptor.remoteUrl) && local.branch === descriptor.branch
    ? { state: "available", detail: "docs-repo descriptor and local DocumentStore match", remoteUrl: descriptor.remoteUrl, branch: descriptor.branch, headSha: descriptor.headSha }
    : { state: "unavailable", detail: "service descriptor does not match the local DocumentStore remote/branch", remoteUrl: descriptor.remoteUrl, branch: descriptor.branch, headSha: descriptor.headSha };
};
