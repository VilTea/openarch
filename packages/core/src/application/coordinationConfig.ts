import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { coordinationConfigPath } from "../infra/paths";

export interface CoordinationConfig {
  readonly version: 1;
  /** Canonical service base URL. Credentials never belong in project state. */
  readonly url: string;
}

export type CoordinationConfigReadResult =
  | { readonly state: "not_configured"; readonly path: string }
  | { readonly state: "configured"; readonly path: string; readonly config: CoordinationConfig }
  | { readonly state: "invalid"; readonly path: string; readonly reason: string };

export type CoordinationConfigWriteResult =
  | { readonly action: "configured" | "unchanged"; readonly path: string; readonly url: string }
  | { readonly action: "cleared" | "absent"; readonly path: string }
  | { readonly error: string; readonly path: string };

const canonicalUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = new URL(value.trim());
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return undefined;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return undefined;
  }
};

export const readCoordinationConfig = (cwd: string = process.cwd()): CoordinationConfigReadResult => {
  const path = coordinationConfigPath(cwd);
  if (!existsSync(path)) return { state: "not_configured", path };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; url?: unknown };
    const url = raw.version === 1 ? canonicalUrl(raw.url) : undefined;
    return url
      ? { state: "configured", path, config: { version: 1, url } }
      : { state: "invalid", path, reason: "expected version 1 with an http(s) URL without credentials, query, or fragment" };
  } catch {
    return { state: "invalid", path, reason: "invalid JSON" };
  }
};

/** Explicitly configure or clear an optional coordinator; never discovers one. */
export const configureCoordination = (
  input: { readonly cwd: string; readonly url?: string; readonly clear?: boolean },
): CoordinationConfigWriteResult => {
  const path = coordinationConfigPath(input.cwd);
  if (input.clear) {
    if (!existsSync(path)) return { action: "absent", path };
    rmSync(path);
    return { action: "cleared", path };
  }
  const url = canonicalUrl(input.url);
  if (!url) return { error: "coordination URL must be an http(s) base URL without credentials, query, or fragment", path };
  const existing = readCoordinationConfig(input.cwd);
  if (existing.state === "configured" && existing.config.url === url) return { action: "unchanged", path, url };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, url }, null, 2) + "\n", "utf8");
  return { action: "configured", path, url };
};
