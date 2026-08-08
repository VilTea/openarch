import type { JsonRpcMessage } from "../../lsp/jsonRpc";

interface DiagnosticWaiter {
  readonly pending: Set<string>;
  readonly resolve: (ready: boolean) => void;
  readonly timer: NodeJS.Timeout;
}

export interface DiagnosticReadiness {
  readonly observe: (message: JsonRpcMessage) => void;
  readonly wait: (uris: readonly string[], timeoutMs: number) => Promise<boolean>;
  readonly close: () => void;
}

const diagnosticUriKey = (uri: string): string => process.platform === "win32"
  ? uri.replace(/^file:\/\/\/([a-z]):/i, (_match, drive: string) => `file:///${drive.toLowerCase()}:`)
  : uri;

export const createDiagnosticReadiness = (): DiagnosticReadiness => {
  const received = new Set<string>();
  const waiters = new Set<DiagnosticWaiter>();
  const resolveCompleted = (uri: string): void => {
    const key = diagnosticUriKey(uri);
    received.add(key);
    for (const waiter of [...waiters]) {
      waiter.pending.delete(key);
      if (waiter.pending.size === 0) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(true);
      }
    }
  };
  return {
    observe: (message) => {
      if (message.method !== "textDocument/publishDiagnostics") return;
      const uri = (message.params as { readonly uri?: unknown } | undefined)?.uri;
      if (typeof uri === "string") resolveCompleted(uri);
    },
    wait: (uris, timeoutMs) => new Promise<boolean>((resolve) => {
      const pending = new Set(uris.map(diagnosticUriKey).filter((uri) => !received.has(uri)));
      if (pending.size === 0) { resolve(true); return; }
      const waiter: DiagnosticWaiter = {
        pending,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          resolve(false);
        }, timeoutMs),
      };
      waiters.add(waiter);
    }),
    close: () => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
      waiters.clear();
    },
  };
};
