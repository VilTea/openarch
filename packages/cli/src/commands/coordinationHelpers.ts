// Shared helpers for coordination CLI actions.
import { CoordinationError, execFileHidden, readCoordinationConfig } from "@openarch/core";
import { collectCoordinationContext } from "../coordinationContext";

/** Requires an explicit coordination config; otherwise throws CoordinationError → exit 3. */
export const requireConfigured = (cwd: string): string => {
  const configured = readCoordinationConfig(cwd);
  if (configured.state !== "configured") {
    throw new CoordinationError("http_status", "coordination service is not explicitly configured; run `openarch init --coordination-url <url>` in your project worktree (current directory is not an initialized OpenArch project)");
  }
  return configured.config.url;
};

/** Requires the service descriptor to match the local docs-repo; otherwise fails closed. */
export const requireAvailable = async (cwd: string): Promise<void> => {
  const coordination = await collectCoordinationContext(cwd);
  if (coordination.state !== "available") {
    throw new CoordinationError("http_status", `coordination service unavailable: ${coordination.detail}`);
  }
};

export const gitRevParse = (cwd: string, ref: string): string =>
  execFileHidden("git", ["rev-parse", ref], { cwd, encoding: "utf8" }).trim();

export const currentBranch = (cwd: string): string =>
  execFileHidden("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim();
