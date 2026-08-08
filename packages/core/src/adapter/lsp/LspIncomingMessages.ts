import type { JsonRpcMessage } from "../../lsp/jsonRpc";

/** Minimal neutral client replies required before a server can finish workspace initialization. */
const defaultServerRequestResult = (method: string, params: unknown): unknown => {
  if (method === "workspace/configuration") {
    const items = (params as { readonly items?: unknown })?.items;
    return Array.isArray(items) ? items.map(() => null) : [];
  }
  if (method === "workspace/workspaceFolders") return [];
  return null;
};

export const dispatchIncomingLspMessages = (
  messages: readonly JsonRpcMessage[],
  respond: (message: JsonRpcMessage) => void,
  consumeResponse: (message: JsonRpcMessage) => void,
  observeNotification?: (message: JsonRpcMessage) => void,
): void => {
  for (const message of messages) {
    if (message.method && message.id === undefined) observeNotification?.(message);
    if (message.method && message.id !== undefined) {
      respond({ jsonrpc: "2.0", id: message.id, result: defaultServerRequestResult(message.method, message.params) });
    } else {
      consumeResponse(message);
    }
  }
};
