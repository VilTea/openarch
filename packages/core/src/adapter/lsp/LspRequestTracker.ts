import type { JsonRpcMessage } from "../../lsp/jsonRpc";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface LspRequestTracker {
  readonly send: (message: JsonRpcMessage) => void;
  readonly request: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;
  readonly consumeResponse: (message: JsonRpcMessage) => void;
  readonly failAll: (reason: Error) => void;
}

/** Owns request IDs, timeout cleanup and failure fan-out independently from process transport. */
export const createLspRequestTracker = (write: (message: JsonRpcMessage) => void): LspRequestTracker => {
  let nextId = 1;
  let closed: Error | undefined;
  const pending = new Map<number, PendingRequest & { startedAt: number }>();
  const send = (message: JsonRpcMessage): void => {
    if (closed) throw closed;
    if (process.env.OPENARCH_LSP_DEBUG === "1" && message.id === undefined) {
      console.error(`[lsp] notify ${message.method}`);
    }
    write(message);
  };
  const failAll = (reason: Error): void => {
    if (!closed) closed = reason;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  };
  const consumeResponse = (message: JsonRpcMessage): void => {
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (process.env.OPENARCH_LSP_DEBUG === "1") console.error(`[lsp] <- ${message.id} @${((Date.now() - entry.startedAt) / 1000).toFixed(1)}s`);
    if (message.error) entry.reject(new Error(`LSP ${message.error.code}: ${message.error.message}`));
    else entry.resolve(message.result);
  };
  const request = <T>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> => new Promise<T>((resolve, reject) => {
    if (closed) { reject(closed); return; }
    const id = nextId++;
    const startedAt = Date.now();
    if (process.env.OPENARCH_LSP_DEBUG === "1") console.error(`[lsp] -> ${method} id=${id} timeout=${timeoutMs}ms`);
    const timer = setTimeout(() => {
      pending.delete(id);
      if (process.env.OPENARCH_LSP_DEBUG === "1") console.error(`[lsp] !! ${method} id=${id} 超时 @${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      reject(new Error(`LSP ${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, startedAt });
    try { send({ jsonrpc: "2.0", id, method, params }); } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return { send, request, consumeResponse, failAll };
};
