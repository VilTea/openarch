import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { decodeJsonRpc, encodeJsonRpc } from "../../src/lsp/jsonRpc";
import { lspLaunchSpec, startLspSession, type LspProcess } from "../../src/adapter/lsp/NodeLspSession";

class FakeLspProcess extends EventEmitter implements LspProcess {
  readonly writes: Buffer[] = [];
  readonly stdin = {
    write: (data: Uint8Array): boolean => {
      this.writes.push(Buffer.from(data));
      return true;
    },
    on: (event: "error", listener: (error: Error) => void): this => super.on(`stdin:${event}`, listener),
  };
  readonly stdout = {
    on: (event: "data", listener: (chunk: Buffer) => void): this => super.on(`stdout:${event}`, listener),
  };
  killed = false;

  emitResponse(message: Parameters<typeof encodeJsonRpc>[0]): void {
    this.emit("stdout:data", encodeJsonRpc(message));
  }

  kill = (): void => {
    this.killed = true;
  };
}

describe("Node LSP session", () => {
  it("passes providers an executable protocol endpoint rather than a shell command", () => {
    expect(lspLaunchSpec("C:/tools/pyright-langserver.cmd")).toEqual({
      command: "C:/tools/pyright-langserver.cmd",
      args: ["--stdio"],
    });
  });

  it("matches responses to requests and rejects outstanding work on process exit", async () => {
    const process = new FakeLspProcess();
    const session = startLspSession(lspLaunchSpec("pyright-langserver"), "/workspace", () => process);
    const first = session.request<string>("first", {});
    const second = session.request<string>("second", {});
    const messages = decodeJsonRpc(Buffer.concat(process.writes)).messages;

    process.emitResponse({ jsonrpc: "2.0", id: messages[1]!.id, result: "second-result" });
    process.emit("exit", 2);

    await expect(second).resolves.toBe("second-result");
    await expect(first).rejects.toThrow("exited (2)");
  });

  it("times out a request without closing the session", async () => {
    const process = new FakeLspProcess();
    const session = startLspSession(lspLaunchSpec("pyright-langserver"), "/workspace", () => process);

    await expect(session.request("slow", {}, 1)).rejects.toThrow("LSP slow timed out");
    expect(process.killed).toBe(false);
    expect(() => session.notify("after-timeout", {})).not.toThrow();
  });

  it("fails closed and terminates the transport for malformed protocol output", async () => {
    const process = new FakeLspProcess();
    const session = startLspSession(lspLaunchSpec("pyright-langserver"), "/workspace", () => process);
    const request = session.request("initialize", {});

    process.emit("stdout:data", Buffer.from("Content-Length: invalid\r\n\r\n{}"));

    await expect(request).rejects.toThrow("Content-Length");
    expect(process.killed).toBe(true);
  });

  it("answers server workspace requests so language servers can finish initialization", () => {
    const process = new FakeLspProcess();
    startLspSession(lspLaunchSpec("pyright-langserver"), "/workspace", () => process);

    process.emitResponse({ jsonrpc: "2.0", id: 99, method: "workspace/configuration", params: { items: [{ section: "go" }, { section: "rust-analyzer" }] } });
    process.emitResponse({ jsonrpc: "2.0", id: "folders", method: "workspace/workspaceFolders" });

    expect(decodeJsonRpc(Buffer.concat(process.writes)).messages).toEqual([
      { jsonrpc: "2.0", id: 99, result: [null, null] },
      { jsonrpc: "2.0", id: "folders", result: [] },
    ]);
  });

  it("waits for diagnostics notifications using canonical Windows file URIs", async () => {
    const process = new FakeLspProcess();
    const session = startLspSession(lspLaunchSpec("rust-analyzer"), "/workspace", () => process);
    const ready = session.waitForDiagnostics?.(["file:///C:/workspace/src/lib.rs"], 100);

    process.emitResponse({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///c:/workspace/src/lib.rs", diagnostics: [] },
    });

    await expect(ready).resolves.toBe(true);
  });
});
