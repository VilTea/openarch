import { describe, expect, it } from "vitest";
import { decodeJsonRpc, encodeJsonRpc } from "../../src/lsp/jsonRpc";

describe("LSP JSON-RPC framing", () => {
  it("retains incomplete frames and then decodes concatenated messages", () => {
    const first = encodeJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const second = encodeJsonRpc({ jsonrpc: "2.0", id: 2, result: [] });
    const partial = decodeJsonRpc(first.subarray(0, 11));
    expect(partial.messages).toEqual([]);

    const complete = decodeJsonRpc(Buffer.concat([partial.remaining, first.subarray(11), second]));
    expect(complete.messages).toEqual([
      expect.objectContaining({ id: 1, method: "initialize" }),
      expect.objectContaining({ id: 2, result: [] }),
    ]);
    expect(complete.remaining).toHaveLength(0);
  });

  it("rejects invalid framing rather than treating it as an empty response", () => {
    expect(() => decodeJsonRpc(Buffer.from("Content-Length: nope\r\n\r\n{}"))).toThrow("Content-Length");
  });
});
