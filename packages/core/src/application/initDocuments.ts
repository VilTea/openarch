import { existsSync, writeFileSync } from "node:fs";
import { associateFromLocal, associateFromUrl, checkSyncStatus, statusDocsRepo, unlinkDocsRepo } from "../docs-repo/DocsRepoManager";
import { createSymlink } from "../docs-repo/SymlinkManager";
import { capabilityAssetPath, configureSharedDocumentStore, initializeProjectDocumentStore, installDocumentAdvisoryHook, resolveDocumentStore } from "../document-store/DocumentStore";
import type { InitInput, InitOutput } from "./initTypes";

const configureScope = (input: InitInput, messages: string[]): InitOutput | undefined => {
  if (!input.documentScope) return undefined;
  const separator = input.documentScope.indexOf("=");
  const configured = configureSharedDocumentStore(
    input.cwd,
    separator > 0 ? input.documentScope.slice(separator + 1) : "",
    separator > 0 ? input.documentScope.slice(0, separator) : "",
  );
  if ("error" in configured) return { code: 3, messages: [...messages, `✗ ${configured.error}`] };
  messages.push(`✓ 文档 scope 已登记: ${configured.scopeId}`);
  if (input.installHook) messages.push(`  文档库 hook: ${installDocumentAdvisoryHook(configured)}`);
  return undefined;
};

const associateDocuments = (input: InitInput): InitOutput => {
  const messages: string[] = [];
  const fromUrl = /^(git@|https?:\/\/|git:\/\/)/.test(input.docsRepo!);
  const result = fromUrl ? associateFromUrl(input.docsRepo!, input.cwd) : associateFromLocal(input.docsRepo!, input.cwd);
  if ("error" in result) return { code: 3, messages: [`✗ ${result.error}`] };
  messages.push(`✓ 关联 (${result.symlinkMethod}) → ${result.symlinkPath}`);
  if (fromUrl) {
    const sync = checkSyncStatus(input.cwd);
    if (sync && sync.behind > 0) messages.push(`  ⚠ behind ${sync.behind} commits`);
  }
  const scope = configureScope(input, messages);
  return scope ?? { code: 0, messages };
};

export const configureInitDocuments = (input: InitInput): InitOutput | undefined => {
  if (input.documentStore === "project" && input.docsRepo) return { code: 3, messages: ["--docs-store project 不能与 --docs-repo 同时使用"] };
  if (input.docsRepo && input.unlink) {
    const result = unlinkDocsRepo(input.cwd);
    return { code: result.unlinked ? 0 : 3, messages: [result.unlinked ? "✓ 协作文档仓库关联已断开" : "✗ 未找到已关联的协作文档仓库"] };
  }
  if (input.docsRepo) return associateDocuments(input);
  return input.documentScope ? { code: 3, messages: ["--docs-scope 只能与 --docs-repo 一起使用"] } : undefined;
};

export const ensureProjectDocumentStore = (input: InitInput): void => {
  const existingDocsRepo = statusDocsRepo(input.cwd);
  if (input.documentStore === "project" || (!input.documentStore && !existingDocsRepo.associated)) initializeProjectDocumentStore(input.cwd);
};

export const documentStoreMessages = (cwd: string): string[] => {
  let docs = statusDocsRepo(cwd);
  if (docs.associated && !docs.symlinkValid && docs.config?.target && existsSync(docs.config.target)) {
    try { createSymlink(docs.config.target, `${cwd}/.openarch/docs-repo`); }
    catch { writeFileSync(`${cwd}/.openarch/.docs-repo-path`, docs.config.target); }
    docs = statusDocsRepo(cwd);
  }
  const store = resolveDocumentStore(cwd);
  if (store?.mode === "project-local") return [`  项目文档库: ${store.root}`, `  能力清单: ${capabilityAssetPath(store)}`];
  if (!docs.associated || !docs.symlinkValid) return [docs.associated ? "  ⚠ 软链接失效" : "  ℹ 尚未关联协作文档仓库。openarch init --docs-repo <url|path>"];
  const messages = [`  协作文档仓库: ${docs.config?.target} (${docs.config?.type})`];
  if (!store?.scopeConfigured) return [...messages, "  ⚠ shared document scope 未登记；能力清单不可用"];
  const capabilities = capabilityAssetPath(store);
  messages.push(`  文档 scope: ${store.scopeId} (${store.scopeRoot})`);
  messages.push(existsSync(capabilities) ? `  能力清单: ${capabilities} (已存在)` : "  → 请在当前 document scope 创建能力清单");
  return messages;
};
