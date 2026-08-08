import { execFileSync } from "node:child_process";

export const MAX_GIT_BLOB_BYTES = 512 * 1024;

export interface GitBlobRequest {
  readonly key: string;
  readonly object: string;
}

export interface SourceText {
  readonly text?: string;
  readonly omitted: boolean;
}

interface GitBlobInfo { readonly size?: number; }

const nul = 0;

const gitBuffer = (cwd: string, args: readonly string[], input: Buffer): Buffer =>
  execFileSync("git", args, { cwd, input, encoding: "buffer", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 128 * 1024 * 1024 }) as Buffer;

const batchInput = (requests: readonly GitBlobRequest[]): Buffer => Buffer.from(`${requests.map((request) => request.object).join("\0")}\0`);

const nextBatchHeader = (raw: Buffer, offset: number): { readonly header: string; readonly offset: number } | undefined => {
  const end = raw.indexOf(nul, offset);
  if (end < 0) return undefined;
  return { header: raw.subarray(offset, end).toString("utf8"), offset: end + 1 };
};

const batchBlobInfo = (cwd: string, requests: readonly GitBlobRequest[]): ReadonlyMap<string, GitBlobInfo> => {
  if (requests.length === 0) return new Map();
  const raw = gitBuffer(cwd, ["cat-file", "--batch-check", "-Z"], batchInput(requests));
  const info = new Map<string, GitBlobInfo>();
  let offset = 0;
  for (const request of requests) {
    const item = nextBatchHeader(raw, offset);
    if (!item) break;
    offset = item.offset;
    const match = /^(?:[0-9a-f]{40,64}) blob (\d+)$/.exec(item.header);
    info.set(request.key, match ? { size: Number(match[1]) } : {});
  }
  return info;
};

/** Reads bounded historical blobs with two Git processes regardless of file count. */
export const readGitBlobs = (cwd: string, requests: readonly GitBlobRequest[]): ReadonlyMap<string, SourceText> => {
  const result = new Map<string, SourceText>(requests.map((request) => [request.key, { omitted: false }]));
  if (requests.length === 0) return result;
  const info = batchBlobInfo(cwd, requests);
  const readable = requests.filter((request) => {
    const size = info.get(request.key)?.size;
    if (size === undefined) return false;
    if (size > MAX_GIT_BLOB_BYTES) { result.set(request.key, { omitted: true }); return false; }
    return true;
  });
  if (readable.length === 0) return result;

  const raw = gitBuffer(cwd, ["cat-file", "--batch", "-Z"], batchInput(readable));
  let offset = 0;
  for (const request of readable) {
    const item = nextBatchHeader(raw, offset);
    if (!item) break;
    const match = /^(?:[0-9a-f]{40,64}) blob (\d+)$/.exec(item.header);
    if (!match) { offset = item.offset; continue; }
    const size = Number(match[1]);
    const contentEnd = item.offset + size;
    if (contentEnd >= raw.length || raw[contentEnd] !== nul) break;
    result.set(request.key, { text: raw.subarray(item.offset, contentEnd).toString("utf8"), omitted: false });
    offset = contentEnd + 1;
  }
  return result;
};
