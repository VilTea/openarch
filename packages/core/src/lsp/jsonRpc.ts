export interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

const separator = Buffer.from("\r\n\r\n");

export const encodeJsonRpc = (message: JsonRpcMessage): Buffer => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
};

/** Consumes complete LSP frames while retaining an incomplete tail for the next stdout chunk. */
export const decodeJsonRpc = (input: Buffer): { readonly messages: readonly JsonRpcMessage[]; readonly remaining: Buffer } => {
  const messages: JsonRpcMessage[] = [];
  let remaining = input;
  while (true) {
    const headerEnd = remaining.indexOf(separator);
    if (headerEnd < 0) return { messages, remaining };
    const header = remaining.subarray(0, headerEnd).toString("ascii");
    const length = Number(/^Content-Length:\s*(\d+)\s*$/im.exec(header)?.[1]);
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("LSP message has no valid Content-Length header");
    const bodyStart = headerEnd + separator.length;
    if (remaining.length < bodyStart + length) return { messages, remaining };
    const body = remaining.subarray(bodyStart, bodyStart + length).toString("utf8");
    const message = JSON.parse(body) as JsonRpcMessage;
    if (message.jsonrpc !== "2.0") throw new Error("LSP message is not JSON-RPC 2.0");
    messages.push(message);
    remaining = remaining.subarray(bodyStart + length);
  }
};
